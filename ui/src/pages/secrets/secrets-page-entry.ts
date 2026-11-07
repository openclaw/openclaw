export async function loadSecretsPage() {
  // Start the code font alongside the page without delaying fallback rendering.
  void document.fonts.load('14px "JetBrains Mono"').catch(() => {});
  return (await import("./secrets-page.tsx")).SecretsPage;
}
