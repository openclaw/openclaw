import { z } from "zod";
import { validateProviderSettings } from "./provider-settings.js";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { configUiMetadata, sensitive } from "./zod-schema.sensitive.js";

const StorageSettingsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const message = validateProviderSettings(value, "Storage location");
  if (message) {
    ctx.addIssue({ code: "custom", message });
  }
});

const StorageLocationSchema = z
  .strictObject({
    provider: z.string().trim().min(1).register(configUiMetadata, {
      label: "Storage Provider",
      help: 'Storage provider id, such as "filesystem". Referencing a bundled provider automatically enables its plugin unless plugin policy disables it.',
    }),
    settings: StorageSettingsSchema.register(configUiMetadata, {
      label: "Storage Provider Settings",
      help: "Provider-owned bounded JSON settings. Secret-bearing values must use SecretRef objects, which the provider resolves only when needed. The filesystem provider requires an absolute path to an existing directory.",
    }),
    encryption: z
      .union([
        z.literal("none"),
        z.strictObject({
          passphrase: SecretInputSchema.register(sensitive).register(configUiMetadata, {
            label: "Storage Encryption Passphrase",
            help: "Passphrase used to encrypt this location. Prefer a SecretRef and keep a recoverable copy: losing or changing the passphrase makes existing encrypted objects unreadable.",
          }),
        }),
      ])
      .register(configUiMetadata, {
        label: "Storage Encryption",
        help: 'Required encryption choice: a passphrase object encrypts objects before upload; "none" explicitly disables encryption. Backups can contain credentials, so use "none" only when the destination already provides suitable protection.',
      }),
  })
  .register(configUiMetadata, {
    label: "Storage Location",
    help: "One named storage destination with provider settings and an explicit encryption choice. Initialize a new destination with openclaw storage init before writing objects.",
  });

export const StorageConfigSchema = z
  .strictObject({
    locations: z
      .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), StorageLocationSchema)
      .optional()
      .register(configUiMetadata, {
        label: "Storage Locations",
        help: "Named storage destinations. Names contain 1–63 lowercase letters, digits, or hyphens and start with a letter or digit. Each destination keeps an initialization marker that runtime writes never create.",
      }),
  })
  .optional()
  .register(configUiMetadata, {
    label: "Storage",
    help: "Reusable storage locations for OpenClaw artifacts. Core storage owns location identity, encryption, and health; providers transport objects and consumers decide what to retain.",
  });

export const { labels: STORAGE_FIELD_LABELS, help: STORAGE_FIELD_HELP } =
  projectConfigFieldMetadata(StorageConfigSchema, "storage");
