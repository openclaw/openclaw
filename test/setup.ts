// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { sha256File } from "@openclaw/fs-safe/durability";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();
// Select the host binding before platform fixtures can poison the dependency's process cache.
await sha256File(fileURLToPath(import.meta.url));
