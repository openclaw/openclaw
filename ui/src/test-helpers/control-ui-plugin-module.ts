import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { ControlUiPluginModule } from "../plugins/control-ui-loader.ts";

/** Native integration fixtures consume the declared UI entry through Vitest's Solid compiler. */
export async function loadControlUiPluginFixture(packageUrl: URL): Promise<ControlUiPluginModule> {
  // Vite's URL-asset transform also runs for Node/jsdom; only real browsers fetch /@fs/.
  if (
    typeof process !== "undefined" &&
    process.versions?.node &&
    packageUrl.pathname.startsWith("/@fs/")
  ) {
    packageUrl = (await import("node:url")).pathToFileURL(
      decodeURIComponent(packageUrl.pathname.slice(4)),
    );
  }
  const metadata: unknown =
    packageUrl.protocol === "file:"
      ? JSON.parse(await (await import("node:fs/promises")).readFile(packageUrl, "utf8"))
      : await (await fetch(packageUrl)).json();
  const source = asRecord(asRecord(metadata)?.openclaw)?.controlUi;
  if (
    typeof source !== "string" ||
    !source ||
    source.startsWith("/") ||
    source.split("/").includes("..")
  ) {
    throw new Error("Plugin fixture requires its package-declared browser entry.");
  }
  const entry = new URL(source, packageUrl);
  const id =
    entry.protocol === "file:" ? (await import("node:url")).fileURLToPath(entry) : entry.href;
  return vi.importActual<ControlUiPluginModule>(id);
}
