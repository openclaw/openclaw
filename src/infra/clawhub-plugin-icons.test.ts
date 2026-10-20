import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClawHubPluginIconUrls } from "./clawhub-plugin-icons.js";

const packageName = "@acme/calendar";
const packageMetadata = {
  name: packageName,
  displayName: "Calendar",
  family: "code-plugin",
  isOfficial: false,
};

afterEach(() => vi.restoreAllMocks());

describe("ClawHub plugin branding metadata", () => {
  it.each([null, `/api/v1/skill-icons/${"a".repeat(64)}`, "https://cdn.example/icon.png"])(
    "reads package icon %s and publisher image in order through one exact public request",
    async (icon) => {
      const image = "https://cdn.example/publisher.png";
      const fetchImpl = vi.fn(async () =>
        Response.json({ package: { ...packageMetadata, icon }, owner: { image } }),
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
      const result = await fetchClawHubPluginIconUrls({
        packageName,
        baseUrl: "https://clawhub.ai",
        skipAuth: true,
      });
      expect(result).toEqual(
        icon ? [icon.startsWith("/") ? `https://clawhub.ai${icon}` : icon, image] : [image],
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
      expect(url.href).toBe("https://clawhub.ai/api/v1/packages/%40acme%2Fcalendar");
      expect(new Headers(request.headers).has("Authorization")).toBe(false);
    },
  );

  it("rejects a different returned package identity", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ package: { ...packageMetadata, name: "@other/calendar" } }),
    );
    await expect(
      fetchClawHubPluginIconUrls({
        packageName,
        skipAuth: true,
      }),
    ).rejects.toThrow("changed the requested package identity");
  });
});
