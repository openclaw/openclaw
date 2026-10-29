/** Await progress without changing the legacy `void` acceptance contract. */
export async function settleProgressVisibilityCallbackResult(
  callbackResult: boolean | void | Promise<boolean | void>,
): Promise<{ result: boolean | void; visible: boolean }> {
  const result = await callbackResult;
  return { result, visible: result !== false };
}
