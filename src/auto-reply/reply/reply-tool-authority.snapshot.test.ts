import { afterEach, expect, it } from "vitest";
import { withPreparedToolConstruction } from "../../agents/tool-construction-preparation.js";
import * as facts from "../../config/resolution-facts.js";
import * as snapshots from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

const route = { provider: "openai", model: "test-model" };
const sender = { senderIsOwner: true, senderId: "alice", messageProvider: "telegram" };
const overlay = { ...sender, disableTools: false, traceAuthorized: false };
const authorities: Array<{ close(): void }> = [];
const run = { ...route, ...sender, sessionFile: "/tmp/s.json", workspaceDir: "/tmp/w" };
async function prepare(config: OpenClawConfig, sessionId: string) {
  let projected: OpenClawConfig | undefined;
  const authority = prepareReplyToolAuthority({ run: { ...run, config, sessionId } }, (input) => {
    projected = input.run.config;
    return input;
  });
  authorities.push(authority);
  const fingerprint = await authority.projectAsync(overlay, route);
  return { authority, fingerprint, config: projected! };
}
afterEach(() => {
  authorities.splice(0).forEach((authority) => authority.close());
  snapshots.clearRuntimeConfigSnapshot();
});
it("pins active turns across policy publication and reset", async () => {
  const config: OpenClawConfig = { tools: { deny: ["exec"] } };
  snapshots.setRuntimeConfigSnapshot(config);
  const first = await prepare(config, "first");
  const second = await prepare(config, "second");
  expect(second.config).toBe(first.config);
  expect(second.config).toBe(captureRuntimeConfig(config));
  expect(Object.isFrozen(first.config.tools?.deny)).toBe(true);
  expect(() => first.config.tools!.deny!.push("read")).toThrow(TypeError);
  config.tools!.deny = ["read"];
  snapshots.setRuntimeConfigSnapshot(config);
  const next = await prepare(config, "next");
  expect(next.config).not.toBe(first.config);
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.authority.project(overlay, route)).toBe(first.fingerprint);
  expect(first.config.tools?.deny).toEqual(["exec"]);
  snapshots.clearRuntimeConfigSnapshot();
  snapshots.setRuntimeConfigSnapshot(config);
  expect((await prepare(config, "after-reset")).config).not.toBe(next.config);
});
it.each(["mutable", "captured", "republished", "async-republished"] as const)(
  "pins provenance when publishing a %s config",
  async (input) => {
    const policy: OpenClawConfig = { tools: { deny: ["exec"] } };
    const config = input === "captured" ? captureRuntimeConfig(policy) : policy;
    snapshots.setRuntimeConfigSnapshot(config);
    const first = await prepare(snapshots.getRuntimeConfigSnapshot()!, "first");
    const toolConfig = await withPreparedToolConstruction(
      snapshots.getRuntimeConfigSnapshot()!,
      { env: { HOME: "/tmp/synthetic-home", OPENCLAW_STATE_DIR: "/tmp/synthetic-state" } },
      (prepared) => prepared.config,
    );
    expect(toolConfig).toBe(first.config);
    if (input === "republished") {
      snapshots.setRuntimeConfigSnapshot(first.config);
    } else if (input === "async-republished") {
      snapshots.clearRuntimeConfigSnapshot();
      await snapshots.loadPinnedRuntimeConfigAsync(async () => ({ config: first.config }));
    }
    const source = structuredClone(config);
    const resolution = facts.createConfigResolutionFacts(
      [],
      new Map([["gateway.auth.token", "TOKEN"]]),
    );
    facts.setConfigResolutionFacts(source, resolution);
    expect(
      snapshots.setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: snapshots.getRuntimeConfigSnapshotMetadata()!.revision,
        sourceConfig: source,
      }),
    ).toBe(true);
    const next = await prepare(snapshots.getRuntimeConfigSnapshot()!, "next");
    expect(next.config).not.toBe(first.config);
    expect(facts.getConfigResolutionFacts(next.config)).toBe(resolution);
    expect(facts.getConfigResolutionFacts(first.config)).toBeNull();
    expect(facts.getConfigResolutionFacts(toolConfig)).toBeNull();
  },
);
it("isolates unpublished configs from later edits", async () => {
  snapshots.setRuntimeConfigSnapshot({ tools: { deny: ["write"] } });
  const scoped: OpenClawConfig = { tools: { deny: ["exec"] } };
  const first = await prepare(scoped, "first");
  scoped.tools!.deny = ["read"];
  const next = await prepare(scoped, "next");
  expect(first.config.tools?.deny).toEqual(["exec"]);
  expect(next.config.tools?.deny).toEqual(["read"]);
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(first.authority.project(overlay, route)).toBe(first.fingerprint);
});
