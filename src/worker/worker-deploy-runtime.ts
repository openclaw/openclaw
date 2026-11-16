import "../infra/sealed-runtime-bootstrap.js";
import { registerSealedRuntimeProcessEntrypoints } from "../infra/runtime-process-url.js";

registerSealedRuntimeProcessEntrypoints("worker", import.meta.url);
