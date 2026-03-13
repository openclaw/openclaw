import { getChromeMcpPid } from "../chrome-mcp.js";
import { resolveBrowserExecutableForPlatform } from "../chrome.executables.js";
import { toBrowserErrorResponse } from "../errors.js";
import { createBrowserProfilesService } from "../profiles-service.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { resolveProfileContext } from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";

async function withBasicProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (err) {
    const mapped = toBrowserErrorResponse(err);
    if (mapped) {
      return jsonError(params.res, mapped.status, mapped.message);
    }
    jsonError(params.res, 500, String(err));
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

    const [cdpHttp, cdpReady] = await Promise.all([
      profileCtx.isHttpReachable(300),
      profileCtx.isReachable(600),
    ]);

    const profileState = current.profiles.get(profileCtx.profile.name);
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
      running: cdpReady,
      cdpReady,
      cdpHttp,
      pid:
        profileCtx.profile.driver === "existing-session"
          ? getChromeMcpPid(profileCtx.profile.name)
          : (profileState?.running?.pid ?? null),
      cdpPort: profileCtx.profile.cdpPort,
      cdpUrl: profileCtx.profile.cdpUrl,
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
  });

  // Start browser (profile-aware)
  app.post("/start", async (req, res) => {
    await withBasicProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        await profileCtx.ensureBrowserAvailable();
        res.json({ ok: true, profile: profileCtx.profile.name });
      },
    });
  });

  // Stop browser (profile-aware)
  app.post("/stop", async (req, res) => {
    await withBasicProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        const result = await profileCtx.stopRunningBrowser();
        res.json({
          ok: true,
          stopped: result.stopped,
          profile: profileCtx.profile.name,
        });
      },
    });
  });

  // Reset profile (profile-aware)
  app.post("/reset-profile", async (req, res) => {
    await withBasicProfileRoute({
      req,
      res,
      ctx,
      run: async (profileCtx) => {
        const result = await profileCtx.resetProfile();
        res.json({ ok: true, profile: profileCtx.profile.name, ...result });
      },
    });
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

    try {
      const service = createBrowserProfilesService(ctx);
      const result = await service.createProfile({
        name,
        color: color || undefined,
        cdpUrl: cdpUrl || undefined,
        driver:
          driver === "extension"
            ? "extension"
            : driver === "existing-session"
              ? "existing-session"
              : undefined,
      });
      res.json(result);
    } catch (err) {
      const mapped = toBrowserErrorResponse(err);
      if (mapped) {
        return jsonError(res, mapped.status, mapped.message);
      }
      jsonError(res, 500, String(err));
    }
  });

  // Delete a profile
  app.delete("/profiles/:name", async (req, res) => {
    const name = toStringOrEmpty(req.params.name);
    if (!name) {
      return jsonError(res, 400, "profile name is required");
    }

    try {
      const service = createBrowserProfilesService(ctx);
      const result = await service.deleteProfile(name);
      res.json(result);
    } catch (err) {
      const mapped = toBrowserErrorResponse(err);
      if (mapped) {
        return jsonError(res, mapped.status, mapped.message);
      }
      jsonError(res, 500, String(err));
    }
  });
}
