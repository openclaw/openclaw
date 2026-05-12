import { Type } from "typebox";
import { ENV_SECRET_REF_ID_RE } from "../../../config/types.secrets.js";
import {
  EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN,
  FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN,
  SECRET_PROVIDER_ALIAS_PATTERN,
  SINGLE_VALUE_FILE_REF_ID,
} from "../../../secrets/ref-contract.js";
import { INPUT_PROVENANCE_KIND_VALUES } from "../../../sessions/input-provenance.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../../sessions/session-label.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../client-info.js";

export const NonEmptyString = Type.String({ minLength: 1 });
export const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
export const ChatSendSessionKeyString = Type.String({
  minLength: 1,
  maxLength: CHAT_SEND_SESSION_KEY_MAX_LENGTH,
});
export const SessionLabelString = Type.String({
  minLength: 1,
  maxLength: SESSION_LABEL_MAX_LENGTH,
});
export const InputProvenanceSchema = Type.Object(
  {
    kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
    originSessionId: Type.Optional(Type.String()),
    sourceSessionKey: Type.Optional(Type.String()),
    sourceChannel: Type.Optional(Type.String()),
    sourceTool: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const GatewayClientIdSchema = Type.Enum(GATEWAY_CLIENT_IDS);

export const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES);

// Wire-protocol SecretRef source: open string. Built-in sources (env/file/exec)
// are still validated tightly through the per-source schemas below; non-built-in
// strings (e.g. "gcp", "keyring", any third-party plugin source) are accepted
// via PluginSecretRefSchema. Mirrors the open `SecretRefSource` union in
// `src/config/types.secrets.ts` so a SecretRef that passes config validation
// also passes wire-protocol validation.
export const SecretRefSourceSchema = Type.String({ minLength: 1 });

const SecretProviderAliasString = Type.String({
  pattern: SECRET_PROVIDER_ALIAS_PATTERN.source,
});

const EnvSecretRefSchema = Type.Object(
  {
    source: Type.Literal("env"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: ENV_SECRET_REF_ID_RE.source }),
  },
  { additionalProperties: false },
);

const FileSecretRefIdSchema = Type.Unsafe<string>({
  type: "string",
  anyOf: [
    { const: SINGLE_VALUE_FILE_REF_ID },
    {
      allOf: [
        { pattern: FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN },
        { not: { pattern: FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN } },
      ],
    },
  ],
});

const FileSecretRefSchema = Type.Object(
  {
    source: Type.Literal("file"),
    provider: SecretProviderAliasString,
    id: FileSecretRefIdSchema,
  },
  { additionalProperties: false },
);

const ExecSecretRefSchema = Type.Object(
  {
    source: Type.Literal("exec"),
    provider: SecretProviderAliasString,
    id: Type.String({ pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN }),
  },
  { additionalProperties: false },
);

// Plugin-owned source: any non-empty string that is NOT a built-in literal.
// The negative-lookahead pattern keeps a malformed built-in ref (e.g. an env
// source with a lowercase id) from being silently rescued by this arm —
// it must fail at the strict per-source schema above.
const PluginSecretRefSchema = Type.Object(
  {
    source: Type.String({
      minLength: 1,
      pattern: "^(?!(?:env|file|exec)$).+$",
    }),
    provider: SecretProviderAliasString,
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const SecretRefSchema = Type.Union([
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
  PluginSecretRefSchema,
]);

export const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
