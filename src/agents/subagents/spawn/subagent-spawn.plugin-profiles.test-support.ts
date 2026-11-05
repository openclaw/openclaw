import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { revokePluginRecord } from "../../../plugins/registry-lifecycle.js";
import { createOwnershipRecord } from "../../../plugins/registry-ownership.test-support.js";
import { createTestPluginRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { createRequestNativeSubagentRuntime } from "../../plugin-native-subagent.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  holdNativeCapacity,
  installNativeToolHook,
  nativeRequestSource,
} from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import {
  createSpawnOperatorSource,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerNativePluginProfileCases(options: NativePluginSpawnTestOptions) {
  it("native profiles narrow inherited tools and reject foreign profiles, schema rewrites, and revoked owners", async () => {
    const source = createSpawnOperatorSource();
    const bound = await options.createBoundParent(source.authority);
    const { context, runtime } = await options.createBoundGateway(bound);
    const builder = createTestPluginRegistry();
    fs.mkdirSync(path.dirname(bound.storePath), { recursive: true });
    const root = fs.mkdtempSync(path.join(path.dirname(bound.storePath), "profiles-"));
    const instructions = "S5 pinned reviewer instructions. Never write files.";
    fs.writeFileSync(path.join(root, "reviewer.md"), instructions);
    const record = createOwnershipRecord("review-controller", {
      rootDir: root,
      contracts: { subagentProfiles: ["reviewer"] },
    });
    const api = builder.createApi(record, { config: bound.cfg });
    const schema = {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false,
    };
    expectDefined(
      api.agent.registerSubagentProfile,
      "registration",
    )({
      id: "reviewer",
      description: "Review only",
      instructionsFile: "reviewer.md",
      tools: { deny: ["read", "write", "exec"] },
      outputSchema: schema,
    });
    builder.registry.plugins.push(record);
    await holdNativeCapacity(bound, "profile-capacity");
    const children: string[] = [];
    const failures: unknown[] = [];
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, pluginRegistry: builder.registry, isWebchatConnect: () => false },
        async () => {
          const makeNative = (pluginId: string) =>
            createRequestNativeSubagentRuntime(nativeRequestSource(bound, source), {
              pluginId,
              assertCurrent: source.authority.assertCurrent,
            });
          const native = makeNative(record.id);
          const request = {
            requestId: "review",
            task: "Review",
            profile: "reviewer",
            context: "isolated" as const,
          };
          await expect(makeNative("foreign").spawn(request)).rejects.toThrow(
            "Unknown or undeclared",
          );
          await expect(native.spawn({ ...request, profile: "foreign/reviewer" })).rejects.toThrow(
            "Unknown or undeclared",
          );
          await expect(native.spawn({ ...request, outputSchema: {} })).rejects.toThrow(
            "cannot be replaced",
          );
          expect(subagentRuns.size).toBe(0);
          installNativeToolHook(record.id, async () => ({ params: { outputSchema: {} } }));
          await expect(native.spawn(request)).rejects.toThrow("must preserve");
          expect(subagentRuns.size).toBe(0);
          resetGlobalHookRunner();
          const child = await native.spawn(request);
          children.push(child.runId);
          const entry = expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: child.childSessionKey }),
            "profile child",
          );
          expect(entry).toMatchObject({
            inheritedToolAllow: expect.arrayContaining(["read"]),
            inheritedToolDeny: expect.arrayContaining(["read", "write", "exec"]),
          });
          expect(entry.inheritedToolAllow).not.toContain("exec");
          await expect(native.spawn({ ...request, profile: undefined })).rejects.toThrow(
            "does not match",
          );
          const profileGate = createEnteredGate();
          installNativeToolHook(record.id, profileGate.wait);
          const pending = native.spawn({ ...request, requestId: "revoked" });
          await profileGate.entered;
          revokePluginRecord(builder.registry, record);
          profileGate.release();
          await expect(pending).rejects.toThrow("no longer active");
          expect(subagentRuns.size).toBe(1);
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      resetGlobalHookRunner();
      bound.admission.close();
      bound.parent.cleanup();
      source.closeRequest();
      source.revoke();
      for (const id of children) {
        const queued = holdQueuedSwarmRun(id);
        await queued?.release();
      }
      releaseSwarmRun("profile-capacity");
      failures.push(...(await options.closeBoundGateway(bound, runtime, children[0])));
      const disposal = await disposePluginRegistryInstances(builder.registry);
      expect(disposal.failures).toEqual([]);
      fs.rmSync(root, { recursive: true, force: true });
      options.throwBoundFailures(failures);
    }
  });
}
