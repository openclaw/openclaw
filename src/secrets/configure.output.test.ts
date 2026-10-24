import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { readPersistedSharedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { runSecretsCommand } from "../cli/secrets-cli-output.js";
import { defaultRuntime } from "../runtime.js";
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
      const sharedStore = createAuthProfileStoreFixture(
        kind === "plaintext"
          ? {
              "openai:plaintext": createApiKeyCredential("openai", "synthetic-plaintext-value"),
              "openai:residue": {
                ...createApiKeyCredential("openai", "synthetic-residue-value"),
                keyRef,
              },
              "openai:reference": createApiKeyCredential("openai", "$OPENAI_API_KEY"),
            }
          : {
              "openai:ref": { type: "api_key", provider: "openai", keyRef },
              "openai:dollar": createApiKeyCredential("openai", "$OPENAI_API_KEY"),
              "openai:braced": createApiKeyCredential("openai", "${OPENAI_API_KEY}"),
            },
      );
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
      const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      let stdout = "";
      let stderr = "";
      const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value, space) => {
        stdout += `${JSON.stringify(value, null, space && space > 0 ? space : undefined)}\n`;
      });
      const error = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      try {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
        await expect(
          runSecretsCommand(
            true,
            () => runSecretsConfigureInteractive({ skipProviderSetup: true }),
            () => expect.fail("JSON failures must not use the human renderer."),
            1,
          ),
        ).rejects.toMatchObject({ code: 1 });
      } finally {
        json.mockRestore();
        error.mockRestore();
        if (stdinTTY) {
          Object.defineProperty(process.stdin, "isTTY", stdinTTY);
        } else {
          Reflect.deleteProperty(process.stdin, "isTTY");
        }
      }

      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        error: {
          type: "cli_error",
          message: "No configurable secret-bearing fields found for this agent scope.",
        },
      });
      if (kind === "plaintext") {
        expect(stderr.match(/Shared auth-profile store/g)).toHaveLength(1);
        expect(stderr).toContain("Shared auth-profile store");
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
