/** Keep setup and cold-install choices on the platforms their provider supports. */
export function isProviderAuthChoicePlatformSupported(platforms: unknown): boolean {
  return (
    platforms === undefined || (Array.isArray(platforms) && platforms.includes(process.platform))
  );
}
