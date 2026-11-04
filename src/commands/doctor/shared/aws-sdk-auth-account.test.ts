import { expect, it } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { withDoctorConfigMaintenance } from "../../doctor-config-flow.test-support.js";
import { maybeCreateAwsSdkAuthProfileAccounts } from "./aws-sdk-auth-account.js";

const PROFILE_ID = "amazon-bedrock:aws-sdk";
const MARKER: AuthProfileCredential = {
  type: "api_key",
  provider: "amazon-bedrock",
  key: "aws-sdk-credentials",
};

const cfgWith = (state: OpenClawTestState, auth?: "aws-sdk"): OpenClawConfig => ({
  agents: { entries: { main: { agentDir: state.agentDir("main") } } },
  models: { providers: { "amazon-bedrock": { models: [], ...(auth ? { auth } : {}) } } },
});

function withState(
  run: (params: {
    state: OpenClawTestState;
    create: (
      cfg: OpenClawConfig,
      shouldRepair: boolean,
    ) => ReturnType<typeof maybeCreateAwsSdkAuthProfileAccounts>;
    readProfiles: () => Promise<Record<string, AuthProfileCredential>>;
  }) => Promise<void>,
) {
  return withOpenClawTestState({ label: "aws-sdk-account" }, async (state) => {
    await state.writeAuthProfiles({ version: 1, profiles: {} }, "main");
    // Doctor repairs run under config maintenance, which admits the shared store write.
    await withDoctorConfigMaintenance(() =>
      run({
        state,
        create: (cfg, shouldRepair) =>
          maybeCreateAwsSdkAuthProfileAccounts({ cfg, env: state.env, shouldRepair }),
        readProfiles: async () =>
          (await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir("main"))).profiles,
      }),
    );
  });
}

it("creates the marker account a configured AWS SDK route needs, once", async () => {
  await withState(async ({ state, create, readProfiles }) => {
    const cfg = cfgWith(state, "aws-sdk");

    // A preview reports the missing account without writing it.
    const previewed = await create(cfg, false);
    expect(previewed.changes).toEqual([]);
    expect(previewed.warnings.join("\n")).toContain("openclaw doctor --fix");
    expect(await readProfiles()).toEqual({});

    const created = await create(cfg, true);
    expect(created.warnings).toEqual([]);
    expect(created.changes.join("\n")).toContain(`Created auth profile ${PROFILE_ID}`);
    expect(await readProfiles()).toEqual({ [PROFILE_ID]: MARKER });

    expect(await create(cfg, true)).toEqual({ changes: [], warnings: [] });
    // A provider that does not route through the chain never gets an account.
    expect(await create(cfgWith(state), true)).toEqual({ changes: [], warnings: [] });
  });
});

it("preserves a different account already holding the id and reports the conflict", async () => {
  await withState(async ({ state, create, readProfiles }) => {
    const occupant: AuthProfileCredential = { type: "api_key", provider: "openai", key: "sk-live" };
    await state.writeAuthProfiles({ version: 1, profiles: { [PROFILE_ID]: occupant } }, "main");

    const result = await create(cfgWith(state, "aws-sdk"), true);

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(
      `Auth profile ${PROFILE_ID} already holds a api_key credential for openai`,
    );
    expect(await readProfiles()).toEqual({ [PROFILE_ID]: occupant });
  });
});
