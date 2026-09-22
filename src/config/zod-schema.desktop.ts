// Defines local desktop config parsing and generated field metadata.
import path from "node:path";
import { z } from "zod";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

const DesktopHostConfigShape = {
  enabled: z.boolean().register(configUiMetadata, {
    label: "Desktop Sharing",
    help: "Enables this machine's desktop source. Paired macOS, Windows, and Linux nodes default to enabled; an explicit desktop-app sharing preference takes precedence. The Gateway host Labs source defaults to disabled and applies changes live. Restart a paired node after changing its desktop config.",
  }),
  managed: z.boolean().optional().register(configUiMetadata, {
    label: "Managed Linux Host Desktop",
    help: "Runs and supervises a loopback-only headless TigerVNC/XFCE desktop on Linux. An explicit port or existing default-port VNC server still takes precedence.",
  }),
  port: z.number().int().min(1).max(65_535).optional().register(configUiMetadata, {
    label: "Local VNC Port",
    help: "Loopback RFB port of an already-running VNC server on this machine (default: 5900).",
  }),
  passwordFile: z
    .string()
    .trim()
    .min(1)
    .refine(path.isAbsolute, "VNC passwordFile must be an absolute path")
    .optional()
    .register(configUiMetadata, {
      label: "Local VNC Password File",
      help: "Absolute path to the VNC password file. Omit on macOS to enter account credentials when opening the desktop viewer.",
    }),
};

const DesktopHostConfigSchema = z
  .object(DesktopHostConfigShape)
  .strict()
  .register(configUiMetadata, {
    label: "Local Desktop",
    help: "Connects to an existing loopback VNC server. Linux Gateways can also use an explicitly enabled managed headless desktop.",
  });

const DesktopConfigShape = {
  host: DesktopHostConfigSchema.optional().register(configUiMetadata, {
    label: "Local Desktop",
    help: "Desktop observation for paired nodes, or the experimental Gateway host source, backed by a local VNC server.",
  }),
};

export const DesktopConfigSchema = z.object(DesktopConfigShape).strict().optional();

export const { labels: DESKTOP_FIELD_LABELS, help: DESKTOP_FIELD_HELP } =
  projectConfigFieldMetadata(DesktopConfigSchema, "desktop");
