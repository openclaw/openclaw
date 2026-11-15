import { beforeEach } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import "./loader.base.test-utils.js";
import "./loader.registration.test-utils.js";
import "./loader.activation.test-utils.js";
import "./loader.hooks-and-runtime.test-utils.js";
import "./loader-session-end-permission.test-support.js";
import "./loader.discovery-and-security.test-utils.js";

beforeEach(() => {
  // Registry retirement captures fixture config before asynchronous cleanup.
  setRuntimeConfigSnapshot({});
});
