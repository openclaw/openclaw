import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { isMap, isSeq, parseDocument } from "yaml";

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
