import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tempWorkspaceSync } from "@openclaw/fs-safe/temp";
import { afterEach, expect, it } from "vitest";
import { isMap, isSeq, parseDocument } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const directory = "scripts/k8s/manifests";
const read = (name: string) => parseDocument(readFileSync(`${directory}/${name}.yaml`, "utf8"));
function mapping(value: unknown) {
  if (!isMap(value)) {
    throw new Error("Expected a manifest mapping");
  }
  return value;
}
function named(value: unknown, name: string) {
  if (!isSeq(value)) {
    throw new Error("Expected a manifest sequence");
  }
  return mapping(value.items.find((item) => isMap(item) && item.get("name") === name));
}
const deployment = read("deployment");
const pod = mapping(deployment.getIn(["spec", "template", "spec"]));
const gateway = named(pod.get("containers"), "gateway");
const env = (name: string) => named(gateway.get("env"), name);

it("includes every shipped manifest in kustomization", () => {
  const resources = read("kustomization").get("resources");
  if (!isSeq(resources)) {
    throw new Error("Expected a manifest resource sequence");
  }
  const names = readdirSync(directory).filter(
    (name) => name.endsWith(".yaml") && name !== "kustomization.yaml",
  );
  expect(resources.toJSON()).toEqual(expect.arrayContaining(names));
  expect(resources.items).toHaveLength(names.length);
});

it("connects the service to the deployed gateway", () => {
  const service = read("service");
  const labels = mapping(deployment.getIn(["spec", "template", "metadata", "labels"])).toJSON();
  expect(Object.keys(labels).length).toBeGreaterThan(0);
  expect(mapping(deployment.getIn(["spec", "selector", "matchLabels"])).toJSON()).toEqual(labels);
  expect(mapping(service.getIn(["spec", "selector"])).toJSON()).toEqual(labels);
  const port = named(service.getIn(["spec", "ports"]), "gateway");
  expect(port.toJSON()).toMatchObject({ port: 18789, protocol: "TCP", targetPort: 18789 });
});

it("keeps credentials secret-backed and state writable under the read-only gateway root", () => {
  expect(gateway.toJSON()).toMatchObject({
    command: ["node", "/app/dist/index.js", "gateway", "run"],
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
    },
  });
  expect(env("OPENCLAW_GATEWAY_TOKEN").getIn(["valueFrom", "secretKeyRef", "key"])).toBe(
    "OPENCLAW_GATEWAY_TOKEN",
  );
  expect(env("OPENCLAW_GATEWAY_TOKEN").getIn(["valueFrom", "secretKeyRef", "name"])).toBe(
    "openclaw-secrets",
  );
  const home = named(gateway.get("volumeMounts"), "openclaw-home");
  expect(home.get("mountPath")).toBe("/home/node/.openclaw");
  expect(home.get("mountPath")).toBe(env("OPENCLAW_CONFIG_DIR").get("value"));
  expect(home.get("readOnly")).not.toBe(true);
  expect(env("HOME").get("value")).toBe("/home/node");
  expect(env("XDG_CACHE_HOME").get("value")).toBe("/home/node/.openclaw/.cache");
  const claim = read("pvc").getIn(["metadata", "name"]);
  expect(claim).toEqual(expect.any(String));
  expect(
    named(pod.get("volumes"), "openclaw-home").getIn(["persistentVolumeClaim", "claimName"]),
  ).toBe(claim);
  const config = read("configmap");
  expect(config.getIn(["metadata", "name"])).toEqual(expect.any(String));
  expect(named(pod.get("volumes"), "config").getIn(["configMap", "name"])).toBe(
    config.getIn(["metadata", "name"]),
  );
  expect(JSON.parse(String(config.getIn(["data", "openclaw.json"])))).toMatchObject({
    gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
    agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  });
});

it.skipIf(process.platform === "win32")(
  "admits workspaces through the initialized /tmp mount",
  () => {
    const root = tempDirs.make("openclaw-k8s-tmp-");
    const volume = path.join(root, "volume");
    const home = path.join(root, "state");
    mkdirSync(volume);
    mkdirSync(path.join(home, "workspace"), { recursive: true });
    writeFileSync(path.join(home, "openclaw.json"), "{}");
    writeFileSync(path.join(home, "workspace", "AGENTS.md"), "fixture");
    // A disk-backed emptyDir with fsGroup is writable but lacks sticky protection.
    chmodSync(volume, 0o2777);
    mkdirSync(path.join(volume, "openclaw"), { mode: 0o700 });
    expect(() =>
      tempWorkspaceSync({ rootDir: path.join(volume, "openclaw"), prefix: "probe-" }),
    ).toThrow(expect.objectContaining({ code: "insecure-permissions" }));
    expect(named(pod.get("volumes"), "tmp-volume").get("emptyDir")).toBeDefined();
    const init = named(pod.get("initContainers"), "init-config");
    expect(init.getIn(["securityContext", "runAsUser"])).toBe(
      gateway.getIn(["securityContext", "runAsUser"]),
    );
    const command = init.get("command");
    if (!isSeq(command)) {
      throw new Error("Expected an init command");
    }
    execFileSync("sh", [
      "-c",
      String(command.items[2])
        .replaceAll("/home/node/.openclaw", home)
        .replaceAll("/tmp-volume", volume),
    ]);
    const tmp = named(gateway.get("volumeMounts"), "tmp-volume");
    expect(tmp.get("mountPath")).toBe("/tmp");
    // Moving the subPath mirrors a bind mount: the unsafe volume root is no longer an ancestor.
    const mounted = path.join(root, "tmp");
    const subPath = tmp.get("subPath");
    renameSync(path.join(volume, typeof subPath === "string" ? subPath : ""), mounted);
    const privateRoot = path.join(mounted, "openclaw");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const workspace = tempWorkspaceSync({ rootDir: privateRoot, prefix: "probe-" });
    try {
      workspace.writeText("digest.md", "observer workspace");
      expect(workspace.read("digest.md").toString()).toBe("observer workspace");
    } finally {
      workspace.cleanup();
    }
    expect(named(init.get("volumeMounts"), "tmp-volume").get("mountPath")).toBe("/tmp-volume");
  },
);
