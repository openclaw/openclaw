export function formatProviderLoginCommand(providerRef: string | null | undefined): string {
  // Without a qualified reference, reserved provider names must open the chooser.
  return !providerRef || /^(?:refresh|access|cancel|choice)$/iu.test(providerRef)
    ? "/login"
    : `/login ${providerRef}`;
}
