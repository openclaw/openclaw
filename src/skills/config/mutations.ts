import { mutateConfigFileWithRetry } from "../../config/config.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { parseSecretRef } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

/** A plaintext key would silently replace a SecretRef or `${VAR}` in openclaw.json. */
export class SkillApiKeyReferenceError extends Error {
  constructor(skillKey: string) {
    super(
      `API key not saved — skills.entries.${skillKey}.apiKey is set by a SecretRef or environment variable. Change it in Settings Raw mode or openclaw.json.`,
    );
    this.name = "SkillApiKeyReferenceError";
  }
}

export async function updateSkillConfigEntry(params: {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const committed = await mutateConfigFileWithRetry<Record<string, unknown>>({
    afterWrite: { mode: "auto" },
    mutate: (draft, { snapshot }) => {
      const entries = { ...draft.skills?.entries };
      const current = { ...entries[params.skillKey] };
      if (params.enabled !== undefined) {
        current.enabled = params.enabled;
      }
      if (params.apiKey !== undefined) {
        const trimmed = normalizeSecretInput(params.apiKey);
        if (trimmed === REDACTED_SENTINEL) {
          // Keep the stored secret when a client round-trips a redacted response value.
        } else if (trimmed) {
          // The draft has ${VAR} already substituted; the authored config still names it.
          const authored = (snapshot.authoredConfig ?? snapshot.sourceConfig).skills?.entries?.[
            params.skillKey
          ]?.apiKey;
          if (parseSecretRef(authored) && !parseSecretRef(trimmed)) {
            throw new SkillApiKeyReferenceError(params.skillKey);
          }
          current.apiKey = trimmed;
        } else {
          delete current.apiKey;
        }
      }
      if (params.env) {
        const nextEnv = { ...current.env };
        for (const [key, value] of Object.entries(params.env)) {
          const trimmedKey = key.trim();
          if (!trimmedKey) {
            continue;
          }
          const trimmedVal = value.trim();
          if (trimmedVal === REDACTED_SENTINEL) {
            continue;
          }
          if (!trimmedVal) {
            delete nextEnv[trimmedKey];
          } else {
            nextEnv[trimmedKey] = trimmedVal;
          }
        }
        current.env = nextEnv;
      }
      entries[params.skillKey] = current;
      draft.skills = { ...draft.skills, entries };
      return current;
    },
  });
  return committed.result ?? {};
}
