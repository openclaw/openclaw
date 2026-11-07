import { expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot } from "../../config/config.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { SkillLibraryRequestOwner } from "../server-methods/skills-library.js";
import { prepareGatewaySkillAuthoring } from "../skill-library-authoring.js";
import { captureGatewayToolDiscovery, prepareSessionToolDiscovery } from "../tool-discovery.js";
import {
  createLauncher,
  installLauncherTest,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";

// mock-isolation: The catalog contract must not start external GitHub identity discovery.
vi.mock("../github-publication-discovery.js", () => ({
  readGitHubPublicationFact: () => ({ available: false }),
}));

installLauncherTest();

it("offers a cold worker's personal library declaration without restoring authority", async () => {
  await fx.seedActivePlacement();
  const config = getRuntimeConfigSnapshot()!;
  const profile = ensureProfileForEmail("worker-author@example.test");
  const catalog = await prepareUserProfileCatalog();
  try {
    const owner: SkillLibraryRequestOwner = {
      client: {
        authenticatedUserProfile: { profileId: profile.id },
        connect: { scopes: ["operator.write"] },
      } as SkillLibraryRequestOwner["client"],
      context: { getRuntimeConfig: () => config } as SkillLibraryRequestOwner["context"],
    };
    const authoring = await prepareGatewaySkillAuthoring(owner, fx.SESSION_KEY, true);
    const saved = await prepareSessionToolDiscovery({
      ...fx.sessionTarget,
      getConfig: () => config,
      assertCurrent() {},
      capture: captureGatewayToolDiscovery(owner, true, authoring),
    });
    expect(saved.presentation?.workshop?.defaultTarget).toBe("personal");
    saved[Symbol.dispose]();
    await closeOpenClawAgentDatabasesAsync();
    const observed = new Error("Worker catalog observed before launch");
    const tunnel = fx.createWorkerTurnTunnel({
      launchTurn: async () => {
        throw new Error("unexpected provider launch");
      },
      reconcileWorkspace: fx.reconcileUnchangedLocalWorkspace,
    });
    let offered = false;
    const provider = createLauncher({
      environments: {
        ...fx.unusedEnvironments(),
        get: fx.attachedEnvironment,
        acquireTurnCredential: async () => fx.credential(),
        startTunnel: async () => tunnel,
        createGatewayTools: async ({ skillLibrary }) => {
          expect(skillLibrary?.name).toBe("skill_library");
          expect(skillLibrary!.description).toContain("requesting person's personal library");
          await expect(
            skillLibrary!.execute("cold-write", { action: "list" }),
          ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
          offered = true;
          throw observed;
        },
      },
    });
    const input = fx.turn("cold-worker");
    await expect(provider.executeTurn(runIdentity(input.runId), input, vi.fn())).rejects.toBe(
      observed,
    );
    expect(offered).toBe(true);
  } finally {
    catalog.release();
  }
});
