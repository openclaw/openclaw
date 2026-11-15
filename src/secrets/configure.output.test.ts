import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  createApiKeyCredential as apiKey,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { runSecretsCommand } from "../cli/secrets-cli-output.js";
import { createCliTtyMock, getMockCallOutput } from "../cli/test-runtime-capture.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runSecretsConfigureInteractive } from "./configure.js";

it.each(["plaintext", "references", "missing"])(
  "keeps configure JSON output parseable without changing shared credentials (%s)",
  (kind) =>
    withOpenClawTestState({ layout: "home" }, async (state) => {
      await state.writeConfig({});
      const keyRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
      const sharedStore = createAuthProfileStoreFixture({
        "openai:ref": { type: "api_key", provider: "openai", keyRef },
        "openai:dollar": apiKey("openai", "$OPENAI_API_KEY"),
        "openai:braced": apiKey("openai", "${OPENAI_API_KEY}"),
        ...(kind === "plaintext"
          ? {
              "openai:plaintext": apiKey("openai", "synthetic-plaintext-value"),
              "openai:residue": {
                ...apiKey("openai", "synthetic-residue-value"),
                keyRef,
              },
            }
          : {}),
      });
      noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
      if (kind !== "missing") {
        const { db } = openOpenClawStateDatabase({ env: state.env });
        try {
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
          ).run("authProfiles.store", JSON.stringify(sharedStore));
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      }
      const configBefore = await fs.readFile(state.configPath, "utf8");
      const ttyMock = createCliTtyMock([process.stdin]);
      using output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      using errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        ttyMock.set(true);
        await expect(
          runSecretsCommand(
            true,
            () => runSecretsConfigureInteractive({ skipProviderSetup: true }),
            () => expect.fail("JSON failures must not use the human renderer."),
            1,
          ),
        ).rejects.toMatchObject({ code: 1 });
      } finally {
        ttyMock.restore();
      }

      const stdout = getMockCallOutput(output);
      const stderr = getMockCallOutput(errors);
      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        error: {
          type: "cli_error",
          message: "No configurable secret-bearing fields found for this agent scope.",
        },
      });
      if (kind === "plaintext") {
        expect(stderr).toContain("2 plaintext credential(s)");
        expect(stderr).toContain("cannot migrate shared credentials");
      } else {
        expect(stderr).not.toContain("Shared auth-profile store");
      }
      expect(readPersistedSharedAuthProfileStoreRaw(state.env)).toEqual(
        kind === "missing" ? null : sharedStore,
      );
      expect(`${stdout}${stderr}`).not.toContain("synthetic-plaintext-value");
      expect(`${stdout}${stderr}`).not.toContain("synthetic-residue-value");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
    }),
);
