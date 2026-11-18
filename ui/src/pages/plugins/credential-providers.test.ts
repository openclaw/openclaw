import { expect, it } from "vitest";
import { resolveCredentialProviders } from "./credential-providers.ts";

it("projects source-compatible aliases and canonical built-in defaults without provider contents", () => {
  const config = {
    secrets: {
      defaults: { env: "shell-env", file: "team", store: "shared-store" },
      providers: {
        shell: { source: "env", allowlist: ["PRIVATE_KEY"] },
        team: { source: "file", path: "/private/secrets.json" },
        vault: {
          source: "exec",
          command: "/private/vault-reader",
          env: { TOKEN: "synthetic-secret" },
        },
        default: { source: "exec", command: "/private/default-reader" },
      },
    },
  };
  expect(resolveCredentialProviders(config)).toEqual({
    env: { defaultAlias: "shell-env", aliases: ["shell-env", "shell"] },
    file: { defaultAlias: "team", aliases: ["team"] },
    exec: { defaultAlias: "default", aliases: ["default", "vault"] },
    store: { defaultAlias: "shared-store", aliases: ["shared-store"] },
  });
  expect(resolveCredentialProviders(null)).toEqual({
    env: { defaultAlias: "default", aliases: ["default"] },
    file: { defaultAlias: "default", aliases: [] },
    exec: { defaultAlias: "default", aliases: [] },
    store: { defaultAlias: "default", aliases: ["default"] },
  });
});
