import type { Mock } from "vitest";

export function resetProxyValidationMocks(
  getRuntimeConfigMock: Mock,
  runProxyValidationMock: Mock,
) {
  getRuntimeConfigMock.mockReset();
  getRuntimeConfigMock.mockReturnValue({
    proxy: {
      enabled: true,
      proxyUrl: "http://config-proxy.example:3128",
    },
  });
  runProxyValidationMock.mockReset();
  runProxyValidationMock.mockResolvedValue({
    ok: true,
    config: {
      enabled: true,
      proxyUrl: "http://config-proxy.example:3128",
      source: "config",
      errors: [],
    },
    checks: [
      {
        kind: "allowed",
        url: "https://example.com/",
        ok: true,
        status: 200,
      },
    ],
  });
}
