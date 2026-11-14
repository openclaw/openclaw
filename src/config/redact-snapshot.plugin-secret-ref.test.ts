import { describe, expect, it } from "vitest";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { REDACTED_SENTINEL, redactConfigObject, restoreRedactedValues } from "./redact-snapshot.js";

// #183562: a plugin's secret path has no schema hint when the plugin does not
// declare it (or is not loaded while hints are built). Heuristic redaction then
// masked source and provider as well as the id, and the restore side treated
// the masked identity as a backend change and refused every Control UI save.
const secretRef = { source: "file", provider: "files", id: "/google_oauth_client_secret" };
const original = {
  gateway: { auth: { mode: "token", token: "tok-123456789" } },
  commands: { bash: false },
  plugins: {
    entries: {
      "tangleclaw-google-oauth": {
        enabled: true,
        config: { clientId: "abc.apps.example", clientSecret: { ...secretRef } },
      },
    },
  },
};
type Config = typeof original;
const pickRef = (config: Config) =>
  config.plugins.entries["tangleclaw-google-oauth"].config.clientSecret;
// Hints exist for core paths but say nothing about this plugin's config.
const coreOnlyHints: ConfigUiHints = { "gateway.auth.token": { sensitive: true } };

describe("unhinted plugin SecretRef round trip", () => {
  it.each([
    ["no hints", undefined],
    ["core-only hints", coreOnlyHints],
  ])("restores the masked ref the Control UI sends back unchanged (%s)", (_label, hints) => {
    const redacted = redactConfigObject(structuredClone(original), hints);
    // Without a hint every string of the ref is masked (see redact-snapshot.test.ts).
    expect(pickRef(redacted)).toEqual({
      source: REDACTED_SENTINEL,
      provider: REDACTED_SENTINEL,
      id: REDACTED_SENTINEL,
    });
    expect(JSON.stringify(redacted)).not.toContain(secretRef.id);
    // The Control UI sends the redacted snapshot back with an unrelated change.
    const incoming = structuredClone(redacted);
    incoming.commands.bash = true;
    const restored = restoreRedactedValues(incoming, original, hints);
    expect(restored.ok).toBe(true);
    expect(restored.result).toEqual({ ...original, commands: { bash: true } });
  });

  it("still refuses a changed provider while the id is redacted", () => {
    const incoming = structuredClone(original);
    incoming.plugins.entries["tangleclaw-google-oauth"].config.clientSecret = {
      source: "file",
      provider: "other-files",
      id: REDACTED_SENTINEL,
    };
    const restored = restoreRedactedValues(incoming, original, coreOnlyHints);
    expect(restored.ok).toBe(false);
    expect(restored.humanReadableMessage).toContain("changed source/provider while id is redacted");
  });
});
