// Default test setup installs the shared test environment.
import { ensureSqliteLibrarySelected } from "../src/infra/bun-sqlite-library.js";
import { installSharedTestSetup } from "./setup.shared.js";

if (process.versions.bun) {
  ensureSqliteLibrarySelected();
}
installSharedTestSetup();
