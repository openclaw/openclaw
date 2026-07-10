// K8s manifest tests cover the deployable Kubernetes bundle shape.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Manifest = Record<string, unknown>;

function readManifest(name: string): Manifest {
  const parsed = parse(readFileSync(`scripts/k8s/manifests/${name}`, "utf8")) as unknown;
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  return parsed as Manifest;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
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
    expect(asStrings(kustomization.resources, "kustomization resources").sort()).toEqual([
      "configmap.yaml",
      "deployment.yaml",
      "pvc.yaml",
      "service.yaml",
    ]);
  });

  it("keeps gateway service selectors and ports aligned with deployment labels", () => {
    const deployment = readManifest("deployment.yaml");
    const service = readManifest("service.yaml");
    const deploymentSpec = asRecord(deployment.spec, "deployment spec");
    const selector = asRecord(deploymentSpec.selector, "deployment selector");
    const matchLabels = asRecord(selector.matchLabels, "deployment match labels");
    const template = asRecord(deploymentSpec.template, "deployment template");
    const templateMetadata = asRecord(template.metadata, "deployment template metadata");
    const templateLabels = asRecord(templateMetadata.labels, "deployment template labels");
    const serviceSpec = asRecord(service.spec, "service spec");
    const serviceSelector = asRecord(serviceSpec.selector, "service selector");
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
    const spec = asRecord(deployment.spec, "deployment spec");
    const template = asRecord(spec.template, "deployment template");
    const podSpec = asRecord(template.spec, "pod spec");
    const initContainers = asRecords(podSpec.initContainers, "init containers");
    const initWorkspace = findNamed(initContainers, "init-workspace");
    const initCommand = asStrings(initWorkspace.command, "init workspace command").join("\n");
    const initMounts = asRecords(initWorkspace.volumeMounts, "init workspace volume mounts");
    const containers = asRecords(podSpec.containers, "containers");
    const gateway = findNamed(containers, "gateway");
    const env = asRecords(gateway.env, "gateway env");
    const gatewayMounts = asRecords(gateway.volumeMounts, "gateway volume mounts");
    const volumes = asRecords(podSpec.volumes, "pod volumes");
    const securityContext = asRecord(gateway.securityContext, "gateway security context");

    expect(gateway.command).toEqual(["node", "/app/dist/index.js", "gateway", "run"]);
    expect(findNamed(env, "HOME")).toMatchObject({ value: "/home/node" });
    expect(findNamed(env, "OPENCLAW_CONFIG_PATH")).toMatchObject({
      value: "/etc/openclaw-config/openclaw.json",
    });
    expect(findNamed(env, "OPENCLAW_CONFIG_MANAGED")).toMatchObject({ value: "1" });
    expect(findNamed(env, "OPENCLAW_STATE_DIR")).toMatchObject({ value: "/home/node/.openclaw" });
    expect(env.some((entry) => entry.name === "OPENCLAW_CONFIG_DIR")).toBe(false);
    expect(findNamed(env, "OPENCLAW_GATEWAY_TOKEN")).toMatchObject({
      valueFrom: { secretKeyRef: { key: "OPENCLAW_GATEWAY_TOKEN", name: "openclaw-secrets" } },
    });
    expect(findNamed(gatewayMounts, "config")).toMatchObject({
      mountPath: "/etc/openclaw-config",
      readOnly: true,
    });
    expect(findNamed(gatewayMounts, "config")).not.toHaveProperty("subPath");
    expect(findNamed(gatewayMounts, "openclaw-home")).toMatchObject({
      mountPath: "/home/node/.openclaw",
    });
    expect(initCommand).toContain(
      "cp /etc/openclaw-config/AGENTS.md /home/node/.openclaw/workspace/AGENTS.md",
    );
    expect(initCommand).not.toContain("openclaw.json");
    expect(findNamed(initMounts, "config")).toMatchObject({
      mountPath: "/etc/openclaw-config",
      readOnly: true,
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

  it("applies Kubernetes config without an unconditional pod restart", () => {
    const deployScript = readFileSync("scripts/k8s/deploy.sh", "utf8");
    const secretRestartBlock = deployScript.match(
      /if \$RESTART_AFTER_SECRET_CREATE; then(?<body>[\s\S]*?)\nfi/u,
    )?.groups?.body;
    const executableRestarts = deployScript
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("kubectl rollout restart "));

    expect(deployScript).toContain('kubectl apply -k "$MANIFESTS" -n "$NS"');
    expect(executableRestarts).toEqual(['kubectl rollout restart deployment/openclaw -n "$NS"']);
    expect(secretRestartBlock).toContain(executableRestarts[0]);
    expect(deployScript).toContain('echo "  kubectl rollout restart deployment/openclaw -n $NS"');
  });

  it("keeps config and persistence manifests aligned with the gateway", () => {
    const configMap = readManifest("configmap.yaml");
    const pvc = readManifest("pvc.yaml");
    const data = asRecord(configMap.data, "configmap data");
    const config = JSON.parse(String(data["openclaw.json"])) as Record<string, unknown>;
    const gateway = asRecord(config.gateway, "openclaw config gateway");
    const auth = asRecord(gateway.auth, "openclaw config auth");
    const agents = asRecord(config.agents, "openclaw config agents");
    const defaults = asRecord(agents.defaults, "openclaw config agent defaults");
    const pvcSpec = asRecord(pvc.spec, "pvc spec");
    const resources = asRecord(pvcSpec.resources, "pvc resources");
    const requests = asRecord(resources.requests, "pvc resource requests");

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
