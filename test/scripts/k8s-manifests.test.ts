// K8s manifest tests cover the deployable Kubernetes bundle shape.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { tempWorkspaceSync } from "@openclaw/fs-safe/temp";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Manifest = Record<string, unknown>;

function readManifest(name: string): Manifest {
  const parsed = parse(readFileSync(`scripts/k8s/manifests/${name}`, "utf8")) as unknown;
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  return parsed as Manifest;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function asRecords(value: unknown, label: string): Record<string, unknown>[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as Record<string, unknown>[];
}

function asStrings(value: unknown, label: string): string[] {
  expect(Array.isArray(value), label).toBe(true);
  for (const entry of value as unknown[]) {
    expect(entry, label).toBeTypeOf("string");
  }
  return value as string[];
}

function findNamed(records: Record<string, unknown>[], name: string): Record<string, unknown> {
  const record = records.find((entry) => entry.name === name);
  expect(record, name).toBeDefined();
  return record as Record<string, unknown>;
}

describe("k8s manifests", () => {
  it("keeps kustomization resources aligned with shipped manifests", () => {
    const kustomization = readManifest("kustomization.yaml");

    expect(kustomization).toMatchObject({
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
    });
    expect(asStrings(kustomization.resources, "kustomization resources").toSorted()).toEqual([
      "configmap.yaml",
      "deployment.yaml",
      "pvc.yaml",
      "service.yaml",
    ]);
  });

  it("keeps gateway service selectors and ports aligned with deployment labels", () => {
    const deployment = readManifest("deployment.yaml");
    const service = readManifest("service.yaml");
    const deploymentSpec = assertRecord(deployment.spec, "deployment spec");
    const selector = assertRecord(deploymentSpec.selector, "deployment selector");
    const matchLabels = assertRecord(selector.matchLabels, "deployment match labels");
    const template = assertRecord(deploymentSpec.template, "deployment template");
    const templateMetadata = assertRecord(template.metadata, "deployment template metadata");
    const templateLabels = assertRecord(templateMetadata.labels, "deployment template labels");
    const serviceSpec = assertRecord(service.spec, "service spec");
    const serviceSelector = assertRecord(serviceSpec.selector, "service selector");
    const ports = asRecords(serviceSpec.ports, "service ports");

    expect(deployment).toMatchObject({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "openclaw" },
    });
    expect(matchLabels).toEqual({ app: "openclaw" });
    expect(templateLabels).toMatchObject(matchLabels);
    expect(serviceSelector).toEqual(matchLabels);
    expect(ports).toContainEqual({
      name: "gateway",
      port: 18789,
      protocol: "TCP",
      targetPort: 18789,
    });
  });

  it("keeps deployment mounts, secrets, and security posture deployable", () => {
    const deployment = readManifest("deployment.yaml");
    const spec = assertRecord(deployment.spec, "deployment spec");
    const template = assertRecord(spec.template, "deployment template");
    const podSpec = assertRecord(template.spec, "pod spec");
    const containers = asRecords(podSpec.containers, "containers");
    const gateway = findNamed(containers, "gateway");
    const env = asRecords(gateway.env, "gateway env");
    const volumes = asRecords(podSpec.volumes, "pod volumes");
    const securityContext = assertRecord(gateway.securityContext, "gateway security context");

    expect(gateway.command).toEqual(["node", "/app/dist/index.js", "gateway", "run"]);
    expect(findNamed(env, "HOME")).toMatchObject({ value: "/home/node" });
    expect(findNamed(env, "OPENCLAW_CONFIG_DIR")).toMatchObject({ value: "/home/node/.openclaw" });
    expect(findNamed(env, "OPENCLAW_GATEWAY_TOKEN")).toMatchObject({
      valueFrom: { secretKeyRef: { key: "OPENCLAW_GATEWAY_TOKEN", name: "openclaw-secrets" } },
    });
    expect(findNamed(volumes, "openclaw-home")).toMatchObject({
      persistentVolumeClaim: { claimName: "openclaw-home-pvc" },
    });
    expect(findNamed(volumes, "config")).toMatchObject({ configMap: { name: "openclaw-config" } });
    expect(securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
    });
  });

  it("keeps /tmp sticky-protected through a gateway-tmp subPath", () => {
    const deployment = readManifest("deployment.yaml");
    const spec = assertRecord(deployment.spec, "deployment spec");
    const template = assertRecord(spec.template, "deployment template");
    const podSpec = assertRecord(template.spec, "pod spec");
    const containers = asRecords(podSpec.containers, "containers");
    const gateway = findNamed(containers, "gateway");
    const mounts = asRecords(gateway.volumeMounts, "gateway volume mounts");
    const tmpMount = mounts.find((entry) => entry.name === "tmp-volume");
    expect(tmpMount, "gateway tmp-volume mount").toEqual({
      name: "tmp-volume",
      mountPath: "/tmp",
      subPath: "gateway-tmp",
    });
    expect(findNamed(asRecords(podSpec.volumes, "pod volumes"), "tmp-volume")).toEqual({
      name: "tmp-volume",
      emptyDir: {},
    });

    const initContainers = asRecords(podSpec.initContainers, "init containers");
    const initConfig = findNamed(initContainers, "init-config");
    const initMounts = asRecords(initConfig.volumeMounts, "init-config volume mounts");
    const initTmpMount = initMounts.find((entry) => entry.name === "tmp-volume");
    expect(initTmpMount, "init-config tmp-volume mount").toEqual({
      name: "tmp-volume",
      mountPath: "/tmp-volume",
    });
    const initSecurityContext = assertRecord(
      initConfig.securityContext,
      "init-config security context",
    );
    const gatewaySecurityContext = assertRecord(
      gateway.securityContext,
      "gateway security context",
    );
    expect(initSecurityContext.runAsUser).toBe(gatewaySecurityContext.runAsUser);
    expect(initSecurityContext.runAsGroup).toBe(gatewaySecurityContext.runAsGroup);

    const initCommand = asStrings(initConfig.command, "init-config command");
    const script = initCommand.join("\n");
    expect(script).toContain("mkdir -p /tmp-volume/gateway-tmp");
    expect(script).toContain("chmod 1777 /tmp-volume/gateway-tmp");
    expect(script).toContain("exit 1");
    expect(script).toContain("[ -k /tmp-volume/gateway-tmp ]");
    // P1: a volume that denies the configured UID must fail loudly, not silently.
    expect(script).toContain("writable by UID 1000");
    expect(script).toContain("missing the sticky bit");
  });

  it.runIf(process.platform !== "win32")("prepares a tmp root the fs-safe guard accepts", () => {
    const deployment = readManifest("deployment.yaml");
    const podSpec = assertRecord(
      assertRecord(assertRecord(deployment.spec, "deployment spec").template, "template").spec,
      "pod spec",
    );
    const initConfig = findNamed(
      asRecords(podSpec.initContainers, "init containers"),
      "init-config",
    );
    const script = asStrings(initConfig.command, "init-config command").join("\n");

    // Simulate the deployed volume root: disk-backed emptyDir (0777) plus
    // fsGroup setgid, without the sticky bit.
    const volumeRoot = tempDirs.make("openclaw-k8s-tmp-volume-");
    chmodSync(volumeRoot, 0o2777);
    expect(statSync(volumeRoot).mode & 0o7777).toBe(0o2777);

    // The raw volume root reproduces the shipped failure mode.
    let rawError: unknown;
    try {
      tempWorkspaceSync({ rootDir: volumeRoot, prefix: "probe-" }).cleanup();
    } catch (error) {
      rawError = error;
    }
    expect((rawError as NodeJS.ErrnoException)?.code).toBe("insecure-permissions");

    const prepScript = script
      .split("\n")
      .filter((line) => line.includes("/tmp-volume"))
      .join("\n")
      .replaceAll("/tmp-volume", volumeRoot);
    expect(prepScript).toContain("chmod 1777");
    execFileSync("sh", ["-c", prepScript], { stdio: "pipe" });

    const prepared = path.join(volumeRoot, "gateway-tmp");
    expect(statSync(prepared).mode & 0o1000).toBe(0o1000);

    // The subPath mount re-roots gateway-tmp at /tmp, so the 02777 volume
    // root is not an ancestor at runtime. Mirror that boundary by moving
    // the prepared dir under safe ancestors (rename preserves its mode).
    const mounted = path.join(tempDirs.make("openclaw-k8s-tmp-mnt-"), "tmp");
    renameSync(prepared, mounted);
    expect(statSync(mounted).mode & 0o1000).toBe(0o1000);

    const workspace = tempWorkspaceSync({ rootDir: mounted, prefix: "probe-" });
    workspace.writeText("probe.txt", "sticky-tmp");
    expect(workspace.read("probe.txt").toString()).toBe("sticky-tmp");
    workspace.cleanup();
  });

  it("keeps config and persistence manifests aligned with the gateway", () => {
    const configMap = readManifest("configmap.yaml");
    const pvc = readManifest("pvc.yaml");
    const data = assertRecord(configMap.data, "configmap data");
    const config = JSON.parse(String(data["openclaw.json"])) as Record<string, unknown>;
    const gateway = assertRecord(config.gateway, "openclaw config gateway");
    const auth = assertRecord(gateway.auth, "openclaw config auth");
    const agents = assertRecord(config.agents, "openclaw config agents");
    const defaults = assertRecord(agents.defaults, "openclaw config agent defaults");
    const pvcSpec = assertRecord(pvc.spec, "pvc spec");
    const resources = assertRecord(pvcSpec.resources, "pvc resources");
    const requests = assertRecord(resources.requests, "pvc resource requests");

    expect(configMap).toMatchObject({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "openclaw-config" },
    });
    expect(gateway).toMatchObject({ mode: "local", port: 18789 });
    expect(auth).toMatchObject({ mode: "token" });
    expect(defaults).toMatchObject({ workspace: "~/.openclaw/workspace" });
    expect(data["AGENTS.md"]).toContain("OpenClaw Assistant");
    expect(pvc).toMatchObject({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "openclaw-home-pvc" },
    });
    expect(requests).toMatchObject({ storage: "10Gi" });
  });
});
