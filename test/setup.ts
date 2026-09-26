// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { sha256File } from "@openclaw/fs-safe/durability";
import { ensureSqliteLibrarySelected } from "../src/infra/bun-sqlite-library.js";
import { installSharedTestSetup } from "./setup.shared.js";

if (process.versions.bun) {
  ensureSqliteLibrarySelected();
}
installSharedTestSetup();
// Select the host binding before platform fixtures can poison the dependency's process cache.
await sha256File(fileURLToPath(import.meta.url));
