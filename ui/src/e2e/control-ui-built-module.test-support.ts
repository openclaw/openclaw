import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inject } from "vitest";
import { extractControlUiStartupAssetPaths } from "../../../scripts/check-control-ui-performance.mts";
import { selectControlUiRoutePreloads } from "../../../src/gateway/control-ui-route-preloads.ts";

function builtAssetRequest(files: string[]): RegExp {
  if (files.length === 0) {
    throw new Error("Expected at least one built Control UI asset");
  }
  const names = files.map((file) => path.basename(file).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`/assets/(?:${names.join("|")})(?:\\?.*)?$`, "u");
}

/** Resolve the emitted implementation, including when optimization removes its facade. */
export function controlUiE2eBuiltModuleRequest(
  modulePath: string,
  buildRoot = inject("controlUiE2eBuildRoot"),
): RegExp {
  if (!buildRoot) {
    throw new Error("Built module requests require the bundled Control UI E2E server");
  }
  const assetsDir = path.join(buildRoot, "assets");
  const sourceSuffix = `/${modulePath.replaceAll("\\", "/")}`;
  const chunks = readdirSync(assetsDir).filter((file) => {
    if (!file.endsWith(".js.map")) {
      return false;
    }
    const sourceMap: { sources: string[] } = JSON.parse(
      readFileSync(path.join(assetsDir, file), "utf8"),
    );
    return sourceMap.sources.some((source) => source.replaceAll("\\", "/").endsWith(sourceSuffix));
  });
  if (chunks.length !== 1) {
    throw new Error(`Expected one built chunk for ${modulePath}, found ${chunks.length}`);
  }
  return builtAssetRequest([chunks[0]!.slice(0, -".map".length)]);
}

/** Raw ?url assets retain source bytes instead of participating in module sourcemaps. */
export function controlUiE2eBuiltAssetRequest(
  sourcePath: string,
  buildRoot = inject("controlUiE2eBuildRoot"),
): RegExp {
  if (!buildRoot) {
    throw new Error("Built asset requests require the bundled Control UI E2E server");
  }
  const source = readFileSync(sourcePath);
  const assetsDir = path.join(buildRoot, "assets");
  const assets = readdirSync(assetsDir).filter(
    (file) =>
      path.extname(file) === path.extname(sourcePath) &&
      readFileSync(path.join(assetsDir, file)).equals(source),
  );
  if (assets.length !== 1) {
    throw new Error(`Expected one built asset for ${sourcePath}, found ${assets.length}`);
  }
  return builtAssetRequest(assets);
}

/** Hold the route-only styles actually emitted by the preload owner. */
export function controlUiE2eRouteStylesheetRequest(
  route: "chat" | "new",
  loadedRoute: "chat" | "new",
): RegExp {
  const buildRoot = inject("controlUiE2eBuildRoot");
  if (!buildRoot) {
    throw new Error("Route stylesheet requests require the bundled Control UI E2E server");
  }
  const html = readFileSync(path.join(buildRoot, "index.html"), "utf8");
  const loaded = new Set(
    extractControlUiStartupAssetPaths(selectControlUiRoutePreloads(html, loadedRoute)),
  );
  return builtAssetRequest(
    extractControlUiStartupAssetPaths(selectControlUiRoutePreloads(html, route)).filter(
      (file) => file.endsWith(".css") && !loaded.has(file),
    ),
  );
}
