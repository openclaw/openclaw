import { describe, expect, it } from "vitest";
import {
  assertHostRuntimeNamespace,
  HOST_RUNTIME_NAMESPACE,
  HOST_RUNTIME_NAMESPACE_PREFIX,
  isReservedHostRuntimeNamespace,
} from "./host-runtime-namespace.js";

describe("host-runtime-namespace", () => {
  it("exports the canonical _host.runtime namespace identifier", () => {
    expect(HOST_RUNTIME_NAMESPACE).toBe("_host.runtime");
    expect(HOST_RUNTIME_NAMESPACE_PREFIX).toBe("_host.");
  });

  it("flags _host.* namespaces as host-reserved", () => {
    expect(isReservedHostRuntimeNamespace("_host.runtime")).toBe(true);
    expect(isReservedHostRuntimeNamespace("_host.future")).toBe(true);
    expect(isReservedHostRuntimeNamespace("_host.")).toBe(true);
  });

  it("does not flag plugin-owned or other namespaces as reserved", () => {
    expect(isReservedHostRuntimeNamespace("workflow")).toBe(false);
    expect(isReservedHostRuntimeNamespace("host.runtime")).toBe(false);
    expect(isReservedHostRuntimeNamespace("")).toBe(false);
  });

  it("narrows the canonical namespace through assertHostRuntimeNamespace", () => {
    // Compile-time check via an explicit call: the function returns void on
    // success, so reaching the next statement proves the assertion held.
    expect(() => assertHostRuntimeNamespace(HOST_RUNTIME_NAMESPACE)).not.toThrow();
  });

  it("rejects unknown namespaces from assertHostRuntimeNamespace", () => {
    expect(() => assertHostRuntimeNamespace("workflow")).toThrowError(
      /unknown host run-context namespace: workflow/,
    );
    expect(() => assertHostRuntimeNamespace("_host.future")).toThrowError(
      /unknown host run-context namespace: _host\.future/,
    );
  });
});
