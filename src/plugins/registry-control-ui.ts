import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isOperatorScope } from "../gateway/operator-scopes.js";
import type { ControlUiLinkReaderMetadata } from "../shared/control-ui-link-reader.js";
import {
  isPluginJsonValue,
  normalizeHostHookString,
  normalizeOptionalHostHookString,
  normalizeHostHookStringList,
  type PluginControlUiDescriptor,
} from "./host-hooks.js";
import {
  isReservedControlUiTabSlug,
  validateControlUiNativeRoutePlacement,
} from "./registry-control-ui-policy.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

/** Copy bounded plugin metadata before it becomes a browser routing contract. */
function normalizeLinkReaderMetadata(value: unknown): ControlUiLinkReaderMetadata | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length === 0 ||
    value.hosts.length > 16
  ) {
    return undefined;
  }
  const hostPattern =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
  if (
    !value.hosts.every(
      (host): host is string =>
        typeof host === "string" && host.length <= 253 && hostPattern.test(host),
    )
  ) {
    return undefined;
  }
  const pathPattern = value.pathPattern;
  if (
    typeof pathPattern !== "string" ||
    pathPattern.length > 1024 ||
    !pathPattern.startsWith("^") ||
    !pathPattern.endsWith("$")
  ) {
    return undefined;
  }
  try {
    RegExp(pathPattern, "u");
  } catch {
    return undefined;
  }
  const methodPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u;
  const detailMethod = value.detailMethod;
  const previewMethod = value.previewMethod;
  const imageMethod = value.imageMethod;
  if (
    typeof detailMethod !== "string" ||
    !methodPattern.test(detailMethod) ||
    (previewMethod !== undefined &&
      (typeof previewMethod !== "string" || !methodPattern.test(previewMethod))) ||
    (imageMethod !== undefined &&
      (typeof imageMethod !== "string" || !methodPattern.test(imageMethod)))
  ) {
    return undefined;
  }
  return {
    hosts: [...new Set(value.hosts)],
    pathPattern,
    detailMethod,
    ...(previewMethod !== undefined ? { previewMethod } : {}),
    ...(imageMethod !== undefined ? { imageMethod } : {}),
  };
}

const controlUiSurfaces = new Set<PluginControlUiDescriptor["surface"]>([
  "session",
  "tool",
  "run",
  "settings",
  "tab",
  "widget",
  "link-reader",
]);
export function createControlUiRegistrar(state: PluginRegistryState) {
  const { registry, createRegistration, pushDiagnostic, reportRegistrationError } = state;
  const registerControlUiDescriptor = (
    record: PluginRecord,
    descriptor: PluginControlUiDescriptor,
  ) => {
    // SAFETY: Shipped flat JS descriptors may supply name; it is read as unknown and normalized below.
    const legacyDescriptor = descriptor as PluginControlUiDescriptor & { name?: unknown };
    const id = normalizeHostHookString(descriptor.id);
    const label = normalizeHostHookString(descriptor.label ?? legacyDescriptor.name);
    const description = normalizeOptionalHostHookString(descriptor.description);
    const placement = normalizeOptionalHostHookString(descriptor.placement);
    const slug = descriptor.slug;
    const requiredScopes = normalizeHostHookStringList(descriptor.requiredScopes);
    // The flat API predates required surface/label; preserve shipped JS-plugin behavior.
    const surface = typeof descriptor.surface === "string" ? descriptor.surface : "session";
    if (
      !id ||
      !label ||
      !controlUiSurfaces.has(surface) ||
      description === "" ||
      placement === "" ||
      requiredScopes === null
    ) {
      reportRegistrationError(
        record,
        "control UI descriptor registration requires id, surface, label, and valid optional fields",
      );
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        reportRegistrationError(
          record,
          `control UI descriptor requiredScopes contains unknown operator scope: ${unknownScope}`,
        );
        return;
      }
    }
    if (!validateControlUiNativeRoutePlacement({ record, placement, pushDiagnostic })) {
      return;
    }
    if (slug !== undefined) {
      if (
        typeof slug !== "string" ||
        slug.trim() !== slug ||
        slug.length > 64 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
        surface !== "tab" ||
        placement?.startsWith("route:") ||
        isReservedControlUiTabSlug(slug)
      ) {
        reportRegistrationError(
          record,
          `control UI descriptor slug requires an unreserved lowercase alphanumeric/hyphen segment of at most 64 characters on a tab without native route placement: ${id}`,
        );
        return;
      }
      const owner = registry.controlUiDescriptors.find((entry) => entry.descriptor.slug === slug);
      if (owner) {
        reportRegistrationError(
          record,
          `control UI tab slug already registered by ${owner.pluginId}: ${slug}`,
        );
        return;
      }
    }
    if (descriptor.schema !== undefined && !isPluginJsonValue(descriptor.schema)) {
      reportRegistrationError(
        record,
        `control UI descriptor schema must be JSON-compatible: ${id}`,
      );
      return;
    }
    const existing = registry.controlUiDescriptors.find(
      (entry) => entry.pluginId === record.id && entry.descriptor.id === id,
    );
    if (existing) {
      reportRegistrationError(record, `control UI descriptor already registered: ${id}`);
      return;
    }
    const linkReader =
      surface === "link-reader" ? normalizeLinkReaderMetadata(descriptor.linkReader) : undefined;
    if (
      (surface === "link-reader" && !linkReader) ||
      (surface !== "link-reader" && descriptor.linkReader !== undefined)
    ) {
      reportRegistrationError(
        record,
        "link-reader descriptors require bounded exact hosts, an anchored pathPattern, and method names",
      );
      return;
    }
    const icon = normalizeOptionalHostHookString(descriptor.icon);
    const tabPath = normalizeOptionalHostHookString(descriptor.path);
    // Reject protocol-relative paths so descriptors cannot iframe external content.
    const isLocalAbsolutePath =
      tabPath === undefined ||
      (tabPath.startsWith("/") && !tabPath.startsWith("//") && !tabPath.startsWith("/\\"));
    if (!isLocalAbsolutePath) {
      reportRegistrationError(
        record,
        `control UI descriptor path must be a gateway-local absolute path: ${id}`,
      );
      return;
    }
    const group =
      descriptor.group === "control" || descriptor.group === "agent" ? descriptor.group : undefined;
    const order =
      typeof descriptor.order === "number" && Number.isFinite(descriptor.order)
        ? descriptor.order
        : undefined;
    const capability =
      surface === "tab"
        ? "page"
        : surface === "widget"
          ? "widget"
          : surface === "link-reader"
            ? "link-reader"
            : undefined;
    // Missing declarations are advisory: metadata never grants or denies a UI registration.
    if (capability && record.uiCapabilities && !record.uiCapabilities.includes(capability)) {
      state.reportRegistrationWarning(
        record,
        `Registered UI capability "${capability}" is missing from uiCapabilities in openclaw.plugin.json.`,
      );
    }
    registry.controlUiDescriptors.push(
      createRegistration(record, {
        descriptor: {
          ...descriptor,
          id,
          surface,
          ...(linkReader ? { linkReader } : {}),
          label,
          ...(description !== undefined ? { description } : {}),
          ...(placement !== undefined ? { placement } : {}),
          ...(requiredScopes !== undefined
            ? { requiredScopes: requiredScopes.filter(isOperatorScope) }
            : {}),
          icon,
          path: tabPath,
          group,
          order,
        },
      }),
    );
  };

  return registerControlUiDescriptor;
}
