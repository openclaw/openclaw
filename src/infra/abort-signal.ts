/**
 * 等待AbortSignal被触发
 * @param signal - 可选的AbortSignal，如果已中止则立即返回
 * @returns Promise，在signal被中止时resolve
 */
export async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
