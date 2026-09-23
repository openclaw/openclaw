import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import { resolveSecretRefValues, resolveSecretRefValuesSettledByProvider } from "./resolve.js";

const { readValue } = vi.hoisted(() => ({ readValue: vi.fn() }));
vi.mock("./store/secret-store-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store/secret-store-worker.js")>();
  return { ...actual, readSecretStoreValueAsync: readValue };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const cases = (["env", "file", "exec", "store"] as const).flatMap((source) =>
  [false, true].map((redactedFirst) => ({ source, redactedFirst })),
);

describe.each(cases)(
  "$source mixed failures, redacted first: $redactedFirst",
  ({ source, redactedFirst }) => {
    it.skipIf(source === "exec" && process.platform === "win32")(
      "retains every ref failure from one provider batch",
      async () => {
        const values = { REDACTED_KEY: REDACTED_SENTINEL, HEALTHY_KEY: "healthy-secret" };
        let provider: SecretProviderConfig;
        let command: string | undefined;
        if (source === "file" || source === "exec") {
          const root = tempDirs.make("openclaw-mixed-secret-failures-");
          const filePath = path.join(root, source === "file" ? "secrets.json" : "resolve.sh");
          if (source === "file") {
            await fs.writeFile(filePath, JSON.stringify(values), { mode: 0o600 });
            provider = { source, path: filePath, mode: "json" };
          } else {
            command = filePath;
            const response = JSON.stringify({
              protocolVersion: 1,
              values,
              errors: { ERROR_KEY: { code: "NOT_FOUND" } },
            });
            await fs.writeFile(
              filePath,
              `#!/bin/sh\nprintf 'run\\n' >> "$0.calls"\nprintf '%s' '${response}'\n`,
              { mode: 0o700 },
            );
            provider = { source, command };
          }
        } else {
          provider = { source };
        }
        if (source === "store") {
          readValue.mockImplementation(({ name }: { name: string }) =>
            name === "REDACTED_KEY" || name === "HEALTHY_KEY"
              ? { ok: true, value: values[name] }
              : {
                  ok: false,
                  error: { code: "SECRET_STORE_NOT_FOUND", message: "Missing fixture" },
                },
          );
        }
        const ref = (id: string) => ({
          source,
          provider: "fixture",
          id: source === "file" ? `/${id}` : id,
        });
        const missing = ref("MISSING_KEY");
        const redacted = ref("REDACTED_KEY");
        const refs = [
          ...(redactedFirst ? [redacted, missing] : [missing, redacted]),
          ref("HEALTHY_KEY"),
          ...(source === "exec" ? [ref("ERROR_KEY")] : []),
        ];
        const options = { config: { secrets: { providers: { fixture: provider } } }, env: values };
        const result = await resolveSecretRefValuesSettledByProvider(refs, options);
        expect([...result.resolved]).toEqual([
          [`${source}:fixture:${ref("HEALTHY_KEY").id}`, "healthy-secret"],
        ]);
        expect(result.failures.map(({ error }) => error)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "SECRET_REF_NOT_FOUND",
              source,
              provider: "fixture",
              refId: missing.id,
            }),
            expect.objectContaining({
              code: "SECRET_REF_REDACTED_VALUE",
              source,
              provider: "fixture",
              refId: redacted.id,
            }),
            ...(source === "exec"
              ? [expect.objectContaining({ code: "SECRET_REF_NOT_FOUND", refId: "ERROR_KEY" })]
              : []),
          ]),
        );
        expect(result.failures).toHaveLength(source === "exec" ? 3 : 2);
        if (command) {
          expect(await fs.readFile(`${command}.calls`, "utf8")).toBe("run\n");
        }
        await expect(resolveSecretRefValues(refs, options)).rejects.toMatchObject({
          code: "SECRET_REF_NOT_FOUND",
          source,
          provider: "fixture",
          refId: missing.id,
        });
      },
    );
  },
);
