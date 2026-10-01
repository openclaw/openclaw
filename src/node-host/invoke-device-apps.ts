import { z } from "zod";
import { InstalledAppIdSchema } from "../infra/installed-app-launch.js";
import { prepareLinuxInstalledApp } from "../infra/installed-apps-linux.js";
import { scanInstalledApps, type InstalledApp } from "../infra/installed-apps.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const DeviceAppsParamsSchema = z
  .object({
    appId: InstalledAppIdSchema.optional(),
    query: z.string().trim().min(1).optional(),
    limit: z
      .number()
      .int()
      .transform((value) => Math.min(MAX_LIMIT, Math.max(1, value)))
      .optional(),
    includeSystem: z.boolean().optional(),
  })
  .strict();

type DeviceAppsPayload = {
  count: number;
  totalMatched: number;
  truncated: boolean;
  inventoryComplete?: boolean;
  apps: Array<InstalledApp & { executable?: string }>;
};

type DeviceAppsInvokeResult =
  | { ok: true; payload: DeviceAppsPayload }
  | { ok: false; code: string; message: string };

export async function invokeDeviceApps(params: {
  paramsJSON?: string | null;
  sharingEnabled: boolean;
  platform?: NodeJS.Platform;
  scan?: typeof scanInstalledApps;
}): Promise<DeviceAppsInvokeResult> {
  if (!params.sharingEnabled) {
    return {
      ok: false,
      code: "INSTALLED_APPS_SHARING_DISABLED",
      message: "INSTALLED_APPS_SHARING_DISABLED: enable Installed Apps in node-host settings",
    };
  }
  let request: z.infer<typeof DeviceAppsParamsSchema>;
  try {
    request = DeviceAppsParamsSchema.parse(JSON.parse(params.paramsJSON || "{}"));
  } catch (error) {
    return { ok: false, code: "INVALID_REQUEST", message: String(error) };
  }
  if (request.appId) {
    if ((params.platform ?? process.platform) !== "linux") {
      return {
        ok: false,
        code: "UNAVAILABLE",
        message: "Exact app launch preparation requires Linux",
      };
    }
    try {
      const prepared = prepareLinuxInstalledApp(request.appId);
      const apps = prepared ? [{ ...prepared.app, executable: prepared.executable }] : [];
      return {
        ok: true,
        payload: {
          count: apps.length,
          totalMatched: apps.length,
          inventoryComplete: true,
          truncated: false,
          apps,
        },
      };
    } catch (error) {
      return { ok: false, code: "INSTALLED_APP_LOOKUP_FAILED", message: String(error) };
    }
  }
  const scan = params.scan ?? scanInstalledApps;
  const inventory = await scan({ platform: params.platform ?? process.platform });
  if (inventory.status === "unsupported") {
    return {
      ok: false,
      code: "UNAVAILABLE",
      message: "UNAVAILABLE: installed application inventory is only available on macOS and Linux",
    };
  }
  const query = request.query?.toLocaleLowerCase("en-US");
  const matching = inventory.apps.filter(
    (app) =>
      (request.includeSystem === true || !app.system) &&
      (!query ||
        app.label.toLocaleLowerCase("en-US").includes(query) ||
        app.bundleId?.toLocaleLowerCase("en-US").includes(query)),
  );
  const apps = matching.slice(0, request.limit ?? DEFAULT_LIMIT);
  return {
    ok: true,
    payload: {
      count: apps.length,
      totalMatched: matching.length,
      truncated: inventory.complete === false || matching.length > apps.length,
      ...(inventory.complete !== undefined ? { inventoryComplete: inventory.complete } : {}),
      apps,
    },
  };
}
