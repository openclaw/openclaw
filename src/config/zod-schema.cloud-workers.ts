import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";
import { normalizeCloudRepo } from "./cloud-worker-project-profiles.js";
import { validateProviderSettings } from "./provider-settings.js";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

const CloudWorkerSettingsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const message = validateProviderSettings(value, "Worker profile");
  if (message) {
    ctx.addIssue({ code: "custom", message });
  }
});

const CloudWorkerProfileSchema = z
  .strictObject({
    provider: z.string().trim().min(1).register(configUiMetadata, {
      label: "Cloud Worker Provider",
      help: "Worker provider id registered by a plugin. The configured plugin must expose this id before the gateway can provision environments from the profile.",
    }),
    install: z.enum(["bundle", "npm"]).optional().default("bundle").register(configUiMetadata, {
      label: "Cloud Worker Install Method",
      help: 'Worker installation method: "bundle" (default) transfers the gateway\'s content-hashed installed build and supports released, development, and unreleased versions; "npm" installs the exact gateway version and is available only when that version is released.',
    }),
    suspendAfter: z
      .string()
      .refine((value) => {
        try {
          return /(?:ms|s|m|h|d)$/i.test(value) && parseDurationMs(value) >= 60_000;
        } catch {
          return false;
        }
      }, "Worker profile suspendAfter must be a duration of at least 1m")
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Idle Suspend Duration",
        help: "Automatically reclaims an idle cloud worker after this duration, such as 45m or 2h; the next message provisions a replacement. Minimum: 1m. Leave unset to keep workers running.",
      }),
    readyWorkers: z.number().int().nonnegative().optional().register(configUiMetadata, {
      label: "Cloud Worker Ready Reserve Target",
      help: "Target unassigned prepared workers per eligible project using this profile (default: 1), subject to the Gateway-wide prepared pool cap. Set 0 to disable this profile's reserves while preserving snapshot reuse. Preparing workers and unconfirmed reserve cleanup count toward the target.",
    }),
    settings: CloudWorkerSettingsSchema.optional().register(configUiMetadata, {
      label: "Cloud Worker Provider Settings",
      help: "Provider-owned settings validated by the selected plugin. Use SecretRef objects for secret-bearing values; opaque settings do not gain automatic secret resolution.",
    }),
  })
  .register(configUiMetadata, {
    label: "Cloud Worker Profile",
    help: "One cloud worker profile selected by name when creating an environment. Keep provider credentials in supported references rather than embedding secret material in this block.",
  });
const CloudWorkerProfileIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Worker profile ids must not contain outer whitespace",
  );
const CloudWorkerProjectKeySchema = z
  .string()
  .min(1)
  .refine(
    (value) => normalizeCloudRepo(`https://${value}`) === value,
    "Project profile keys must use lowercase host/owner/repo identities without trailing .git",
  );
const CloudWorkerProjectProfileSchema = CloudWorkerProfileIdSchema.register(configUiMetadata, {
  label: "Cloud Worker Project Profile",
  help: "Cloud worker profile name used by default when a session worktree's origin matches this repository identity.",
});

export const CloudWorkersConfigSchema = z
  .strictObject({
    desktop: z.boolean().optional().register(configUiMetadata, {
      label: "Cloud Worker Desktop (Labs)",
      help: "Enables the experimental worker.desktop.observe surface and Control UI Desktop panel for desktop-capable cloud worker environments.",
    }),
    preparedPool: z
      .strictObject({
        maxTotal: z.number().int().nonnegative().optional().register(configUiMetadata, {
          label: "Cloud Worker Ready Reserve Cap",
          help: "Gateway-wide cap on unassigned prepared cloud workers across projects and profiles (default: 4). Preparing workers and unconfirmed reserve cleanup count toward the cap. Set 0 to drain unassigned reserves and disable replenishment while preserving snapshot reuse and active sessions.",
        }),
      })
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Prepared Pool",
        help: "Limits for prepared cloud workers kept ready for later sessions. Reserves incur running-machine charges until provider cleanup completes; their fixed expiry follows actual project demand and the provider's existing idle policy.",
      }),
    projectProfiles: z
      .record(CloudWorkerProjectKeySchema, CloudWorkerProjectProfileSchema)
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Project Profiles",
        help: "Default cloud worker profile names keyed by normalized lowercase repository identity (host/owner/repo). Explicit dispatch profile ids take precedence.",
      }),
    profiles: z
      .record(CloudWorkerProfileIdSchema, CloudWorkerProfileSchema)
      .optional()
      .register(configUiMetadata, {
        label: "Cloud Worker Profiles",
        help: "Named cloud worker profiles. Each profile selects a worker provider registered by a plugin and carries provider-owned settings.",
      }),
  })
  .optional();

export const { labels: CLOUD_WORKER_FIELD_LABELS, help: CLOUD_WORKER_FIELD_HELP } =
  projectConfigFieldMetadata(CloudWorkersConfigSchema, "cloudWorkers");
