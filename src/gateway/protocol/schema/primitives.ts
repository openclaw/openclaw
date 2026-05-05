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
// Connect-frame auth bounds for protocol-issued bootstrap and device tokens.
// These are machine-generated 32-byte base64url (43 chars) or hex (64 chars)
// values, and the verifier iterates them against every stored pairing/device
// entry under the bootstrap-state mutex. `safeEqualSecret` pads both operands
// to `Math.max(provided, expected)` before `timingSafeEqual`, so an unbounded
// provided value amplifies each per-entry comparison. 256 is well above any
// plausible legitimate value while keeping that scan bounded.
export const HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH = 256;
export const HandshakeBootstrapTokenString = Type.String({
  maxLength: HANDSHAKE_BOOTSTRAP_TOKEN_MAX_LENGTH,
});
// Connect-frame auth bounds for operator-configured shared secrets
// (`auth.token` and `auth.password`). These are matched once per connect
// against a single resolved configured value, so the per-entry amplification
// risk above does not apply. Keep the cap generous to preserve compatibility
// with arbitrarily-sized operator configs (e.g. long random tokens or
// passphrases) while still bounding pre-auth allocation/scan work.
export const HANDSHAKE_SHARED_SECRET_MAX_LENGTH = 4096;
export const HandshakeSharedSecretString = Type.String({
  maxLength: HANDSHAKE_SHARED_SECRET_MAX_LENGTH,
});
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

export const SecretRefSourceSchema = Type.Union([
  Type.Literal("env"),
  Type.Literal("file"),
  Type.Literal("exec"),
]);

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

export const SecretRefSchema = Type.Union([
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

export const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
