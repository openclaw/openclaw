/** Refuse a newer updater's unsupported fresh-capture path before mutation. */
export async function captureUpdateRecoveryBaseline(_params: unknown): Promise<never> {
  throw new Error(
    "Fresh 2026.10 recovery-baseline capture is unavailable in this extended-stable release.",
  );
}
