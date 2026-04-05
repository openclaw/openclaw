/**
 * Mantle's OpenAI-compatible surface currently expects a bearer token.
 * Plain IAM credentials are not sufficient until token generation is wired in.
 */
export function resolveMantleBearerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitToken = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  return explicitToken || undefined;
}
