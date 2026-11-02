export const PACKAGE_REFUSAL_CODES = [
  "package-recovery-permissions-unsafe",
  "managed-handoff-lease-identity-changed",
] as const;
export type PackageRefusalCode = (typeof PACKAGE_REFUSAL_CODES)[number];
export const packageUpdateRefusal = (code: PackageRefusalCode, message: string) =>
  Object.assign(new Error(message), { code });
