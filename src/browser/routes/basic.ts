import { getChromeMcpPid } from "../chrome-mcp.js";
import { resolveBrowserExecutableForPlatform } from "../chrome.executables.js";
import { toBrowserErrorResponse } from "../errors.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { createBrowserProfilesService } from "../profiles-service.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar, BrowserResponse } from "./types.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";

function handleBrowserRouteError(res: BrowserResponse, err: unknown) {
  const mapped = toBrowserErrorResponse(err);
  if (mapped) {
    return jsonError(res, mapped.status, mapped.message);
  }
  jsonError(res, 500, String(err));
}

async function withProfilesServiceMutation(params: {
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (service: ReturnType<typeof createBrowserProfilesService>) => Promise<unknown>;
}) {
  try {
    const service = createBrowserProfilesService(params.ctx);
    const result = await params.run(service);
    params.res.json(result);
  } catch (err) {
    return handleBrowserRouteError(params.res, err);
  }
}

export function registerBrowserBasicRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // List all profiles with their status
  app.get("/profiles", async (_req, res) => {
    try {
      const service = createBrowserProfilesService(ctx);
      const profiles = await service.listProfiles();
      res.json({ profiles });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Get status (profile-aware)
  app.get("/", async (req, res) => {
    let current: ReturnType<typeof ctx.state>;
    try {
      current = ctx.state();
    } catch {
      return jsonError(res, 503, "browser server not started");
    }

    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const [cdpHttp, cdpReady] = await Promise.all([
        profileCtx.isHttpReachable(300),
        profileCtx.isReachable(600),
      ]);

      const profileState = current.profiles.get(profileCtx.profile.name);
      const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
      let detectedBrowser: string | null = null;
      let detectedExecutablePath: string | null = null;
      let detectError: string | null = null;

      try {
        const detected = resolveBrowserExecutableForPlatform(current.resolved, process.platform);
        if (detected) {
          detectedBrowser = detected.kind;
          detectedExecutablePath = detected.path;
        }
      } catch (err) {
        detectError = String(err);
      }

      res.json({
        enabled: current.resolved.enabled,
        profile: profileCtx.profile.name,
        driver: profileCtx.profile.driver,
        transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
        running: cdpReady,
        cdpReady,
        cdpHttp,
        pid: capabilities.usesChromeMcp
          ? getChromeMcpPid(profileCtx.profile.name)
          : (profileState?.running?.pid ?? null),
        cdpPort: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpPort,
        cdpUrl: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpUrl,
        chosenBrowser: profileState?.running?.exe.kind ?? null,
        detectedBrowser,
        detectedExecutablePath,
        detectError,
        userDataDir: profileState?.running?.userDataDir ?? null,
        color: profileCtx.profile.color,
        headless: current.resolved.headless,
        noSandbox: current.resolved.noSandbox,
        executablePath: current.resolved.executablePath ?? null,
        attachOnly: profileCtx.profile.attachOnly,
      });
    } catch (err) {
      const mapped = toBrowserErrorResponse(err);
      if (mapped) {
        return jsonError(res, mapped.status, mapped.message);
      }
      jsonError(res, 500, String(err));
    }
  });

  // Start browser (profile-aware)
  app.post("/start", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      await profileCtx.ensureBrowserAvailable();
      res.json({ ok: true, profile: profileCtx.profile.name });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Stop browser (profile-aware)
  app.post("/stop", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const result = await profileCtx.stopRunningBrowser();
      res.json({
        ok: true,
        stopped: result.stopped,
        profile: profileCtx.profile.name,
      });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Reset profile (profile-aware)
  app.post("/reset-profile", async (req, res) => {
    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const result = await profileCtx.resetProfile();
      res.json({ ok: true, profile: profileCtx.profile.name, ...result });
    } catch (err) {
      jsonError(res, 500, String(err));
    }
  });

  // Create a new profile
  app.post("/profiles/create", async (req, res) => {
    const name = toStringOrEmpty((req.body as { name?: unknown })?.name);
    const color = toStringOrEmpty((req.body as { color?: unknown })?.color);
    const cdpUrl = toStringOrEmpty((req.body as { cdpUrl?: unknown })?.cdpUrl);
    const driver = toStringOrEmpty((req.body as { driver?: unknown })?.driver) as
      | "openclaw"
      | "extension"
      | "existing-session"
      | "";

    if (!name) {
      return jsonError(res, 400, "name is required");
    }

    await withProfilesServiceMutation({
      res,
      ctx,
      run: async (service) =>
        await service.createProfile({
          name,
          color: color || undefined,
          cdpUrl: cdpUrl || undefined,
          driver:
            driver === "extension"
              ? "extension"
              : driver === "existing-session"
                ? "existing-session"
                : undefined,
        }),
    });
  });

  // Delete a profile
  app.delete("/profiles/:name", async (req, res) => {
    const name = toStringOrEmpty(req.params.name);
    if (!name) {
      return jsonError(res, 400, "profile name is required");
    }

    await withProfilesServiceMutation({
      res,
      ctx,
      run: async (service) => await service.deleteProfile(name),
    });
  });
}
