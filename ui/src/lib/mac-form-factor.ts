type MacFormFactor = "laptop" | "mini" | "studio" | "pro" | "imac";

// Apple-silicon entries from kyle-seongwoo-jun/apple-device-identifiers (MIT; see apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md).
const APPLE_SILICON_FORM_FACTORS: Record<string, MacFormFactor> = {
  "Mac13,1": "studio",
  "Mac13,2": "studio",
  "Mac14,2": "laptop",
  "Mac14,3": "mini",
  "Mac14,5": "laptop",
  "Mac14,6": "laptop",
  "Mac14,7": "laptop",
  "Mac14,8": "pro",
  "Mac14,9": "laptop",
  "Mac14,10": "laptop",
  "Mac14,12": "mini",
  "Mac14,13": "studio",
  "Mac14,14": "studio",
  "Mac14,15": "laptop",
  "Mac15,3": "laptop",
  "Mac15,4": "imac",
  "Mac15,5": "imac",
  "Mac15,6": "laptop",
  "Mac15,7": "laptop",
  "Mac15,8": "laptop",
  "Mac15,9": "laptop",
  "Mac15,10": "laptop",
  "Mac15,11": "laptop",
  "Mac15,12": "laptop",
  "Mac15,13": "laptop",
  "Mac15,14": "studio",
  "Mac16,1": "laptop",
  "Mac16,2": "imac",
  "Mac16,3": "imac",
  "Mac16,5": "laptop",
  "Mac16,6": "laptop",
  "Mac16,7": "laptop",
  "Mac16,8": "laptop",
  "Mac16,9": "studio",
  "Mac16,10": "mini",
  "Mac16,11": "mini",
  "Mac16,12": "laptop",
  "Mac16,13": "laptop",
  "Mac17,2": "laptop",
};

const MACBOOK_AIR_IDENTIFIERS = new Set([
  "Mac14,2",
  "Mac14,15",
  "Mac15,12",
  "Mac15,13",
  "Mac16,12",
  "Mac16,13",
]);

const MAC_FORM_FACTOR_PREFIXES = [
  ["MacBook", "laptop"],
  ["Macmini", "mini"],
  ["MacPro", "pro"],
  ["iMac", "imac"],
] as const;

const MAC_FORM_FACTOR_NAMES = [
  [/\bmac\s*book(?:\s*(?:pro|air))?\b/i, "laptop"],
  [/\bmac\s*mini\b/i, "mini"],
  [/\bmac\s*studio\b/i, "studio"],
] as const;

export function resolveMacFormFactor(identifier?: string): MacFormFactor | undefined {
  const model = identifier?.trim();
  if (!model) {
    return undefined;
  }
  return (
    MAC_FORM_FACTOR_PREFIXES.find(([prefix]) => model.startsWith(prefix))?.[1] ??
    (Object.hasOwn(APPLE_SILICON_FORM_FACTORS, model)
      ? APPLE_SILICON_FORM_FACTORS[model]
      : undefined)
  );
}

/** Presentation hint for inventories that expose a display name, not a hardware identifier. */
export function resolveMacFormFactorFromName(name?: string): MacFormFactor | undefined {
  const label = name?.replace(/[_-]+/g, " ");
  if (!label) {
    return undefined;
  }
  return MAC_FORM_FACTOR_NAMES.find(([pattern]) => pattern.test(label))?.[1];
}

export function macFamilyLabel(identifier?: string): string | undefined {
  const model = identifier?.trim();
  if (!model) {
    return undefined;
  }
  const formFactor = resolveMacFormFactor(model);
  if (formFactor === "laptop") {
    if (model.startsWith("MacBookAir") || MACBOOK_AIR_IDENTIFIERS.has(model)) {
      return "MacBook Air";
    }
    return /^MacBook\d/.test(model) ? "MacBook" : "MacBook Pro";
  }
  return formFactor
    ? { mini: "Mac mini", studio: "Mac Studio", pro: "Mac Pro", imac: "iMac" }[formFactor]
    : undefined;
}
