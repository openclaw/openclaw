import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestConfigSnapshot } from "../test-runtime-config-helpers.js";
import { selectChannelSetupOwner } from "./add-wizard.js";

const policy = vi.hoisted(() => ({ read: vi.fn<() => Promise<OpenClawConfig>>() }));
vi.mock("../../config/io.runtime.js", () => ({
  readCurrentConfigForPolicyCheckAsync: policy.read,
}));

afterEach(() => vi.clearAllMocks());

it.each([false, true])(
  "rechecks the channel setup owner after policy preparation (revoked=%s)",
  async (revoked) => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: "/tmp/openclaw-main-workspace" },
          helper: { workspace: "/tmp/openclaw-helper-workspace" },
        },
      },
    };
    const started = createDeferredCore();
    const release = createDeferredCore();
    policy.read.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return config;
    });
    let current = true;
    const operation = selectChannelSetupOwner(
      {
        snapshot: createTestConfigSnapshot(config),
        writeOptions: {
          assertConfigPathForWrite: () => {
            if (!current) {
              throw new Error("configuration owner closed");
            }
          },
        },
      },
      createWizardPrompter({ select: vi.fn().mockResolvedValue({ agentId: "helper" }) }),
    );
    try {
      await Promise.race([
        started.promise,
        operation.then(() => {
          throw new Error("channel selection completed before policy preparation");
        }),
      ]);
      current = !revoked;
      release.resolve();
      if (revoked) {
        await expect(operation).rejects.toThrow("configuration owner closed");
      } else {
        await expect(operation).resolves.toMatchObject({ agentId: "helper" });
      }
    } finally {
      release.resolve();
      await operation.catch(() => {});
    }
  },
);
