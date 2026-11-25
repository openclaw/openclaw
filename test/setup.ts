// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { sha256File } from "@openclaw/fs-safe/durability";
import { isSupported as isProcessIdentitySupported } from "@openclaw/proc-safe/identity";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();
// Select host bindings before platform fixtures can poison the dependencies' process caches.
await sha256File(fileURLToPath(import.meta.url));
isProcessIdentitySupported();
