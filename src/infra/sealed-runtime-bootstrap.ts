import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";
import * as json5 from "json5";
import { registerSealedRuntime } from "./sealed-runtime-registry.js";

// Sealed entries load this before any logging/config consumers. Their private
// JavaScript closure must never resolve packages or optional native code on the host.
configureFsSafeNative({ mode: "off" });
registerSealedRuntime({ json5, resolveSecureTempRoot });
