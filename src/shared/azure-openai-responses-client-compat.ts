export function isTraditionalAzureOpenAIHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") || hostname.endsWith(".cognitiveservices.azure.com")
  );
}

export function isOpenAICompatibleAzureResponsesBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }

  if (isTraditionalAzureOpenAIHost(url.hostname)) {
    return false;
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  return normalizedPath === "/openai/v1" || normalizedPath.endsWith("/openai/v1");
}
