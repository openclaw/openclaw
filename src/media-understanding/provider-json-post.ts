import {
  assertOkOrThrowHttpError,
  readProviderJsonObjectResponse,
  readProviderJsonResponse,
} from "../agents/provider-http-errors.js";
import { postJsonRequest } from "./shared.js";

type ProviderJsonPostParams = Parameters<typeof postJsonRequest>[0] & {
  errorLabel: string;
  responseLabel?: string;
  errorOptions?: Parameters<typeof assertOkOrThrowHttpError>[2];
  readOptions?: Parameters<typeof readProviderJsonResponse>[2];
};

export function postJsonResponse(
  params: ProviderJsonPostParams & { objectResponse: true },
): Promise<Record<string, unknown>>;
export function postJsonResponse<T>(
  params: ProviderJsonPostParams & { objectResponse?: false },
): Promise<T>;
/** Owns the submission response and releases its transport before callers poll or download. */
export async function postJsonResponse(
  params: ProviderJsonPostParams & { objectResponse?: boolean },
): Promise<unknown> {
  const { errorLabel, responseLabel, errorOptions, readOptions, objectResponse, ...request } =
    params;
  const { response, release } = await postJsonRequest(request);
  try {
    await assertOkOrThrowHttpError(response, errorLabel, errorOptions);
    const read = objectResponse ? readProviderJsonObjectResponse : readProviderJsonResponse;
    return await read(response, responseLabel ?? errorLabel, readOptions);
  } finally {
    await release();
  }
}
