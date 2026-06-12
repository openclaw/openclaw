import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContentDisposition,
  buildOssObjectKey,
  buildOssStringToSign,
  contentTypeForExtension,
  DEFAULT_OSS_ALLOWED_EXTENSIONS,
  fileExtension,
  resolveOssConfigFrom,
  signOssRequest,
  uploadFileToOss,
} from "./aliyun-oss.js";

describe("resolveOssConfigFrom", () => {
  it("returns null without credentials", () => {
    expect(resolveOssConfigFrom(undefined, {})).toBeNull();
    expect(resolveOssConfigFrom({ bucket: "b" }, {})).toBeNull();
  });

  it("applies ibtai defaults around plugin credentials", () => {
    const cfg = resolveOssConfigFrom({ accessKeyId: "ak", accessKeySecret: "sk" }, {});
    expect(cfg).toMatchObject({
      accessKeyId: "ak",
      accessKeySecret: "sk",
      bucket: "leadingnews",
      endpoint: "oss-cn-beijing.aliyuncs.com",
      customDomain: "https://oss.ibtai.com",
      pathPrefix: "ibtai/assistant-agent/outputs",
      maxFileSizeMb: 100,
      allowedExtensions: DEFAULT_OSS_ALLOWED_EXTENSIONS,
    });
  });

  it("falls back to ALIYUN_OSS_* env vars and trims slashes", () => {
    const cfg = resolveOssConfigFrom(undefined, {
      ALIYUN_OSS_ACCESS_KEY_ID: "env-ak",
      ALIYUN_OSS_ACCESS_KEY_SECRET: "env-sk",
      ALIYUN_OSS_CUSTOM_DOMAIN: "https://oss.example.com/",
      ALIYUN_OSS_PATH_PREFIX: "/custom/prefix/",
    });
    expect(cfg).toMatchObject({
      accessKeyId: "env-ak",
      customDomain: "https://oss.example.com",
      pathPrefix: "custom/prefix",
    });
  });

  it("normalizes allowedExtensions to lowercase without dots", () => {
    const cfg = resolveOssConfigFrom(
      { accessKeyId: "ak", accessKeySecret: "sk", allowedExtensions: [".DOCX", "Pdf"] },
      {},
    );
    expect(cfg?.allowedExtensions).toEqual(["docx", "pdf"]);
  });
});

describe("buildOssObjectKey", () => {
  it("follows the assistant-agent convention without zero padding", () => {
    const now = new Date("2026-06-03T08:00:00+08:00");
    const key = buildOssObjectKey("ibtai/assistant-agent/outputs", "docx", now);
    const ts = Math.floor(now.getTime() / 1000);
    expect(key).toMatch(
      new RegExp(`^ibtai/assistant-agent/outputs/2026/6/3/${ts}_[0-9a-f]{8}\\.docx$`),
    );
  });

  it("omits the dot when there is no extension", () => {
    const key = buildOssObjectKey("p", "", new Date("2026-12-25T00:00:00+08:00"));
    expect(key).toMatch(/^p\/2026\/12\/25\/\d+_[0-9a-f]{8}$/);
  });
});

describe("fileExtension / contentTypeForExtension", () => {
  it("extracts lowercase extensions", () => {
    expect(fileExtension("速报_20260611.DOCX")).toBe("docx");
    expect(fileExtension("noext")).toBe("");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("maps known types and falls back to octet-stream", () => {
    expect(contentTypeForExtension("docx")).toContain("officedocument.wordprocessingml");
    expect(contentTypeForExtension("weird")).toBe("application/octet-stream");
  });
});

describe("buildContentDisposition", () => {
  it("percent-encodes the UTF-8 filename with an ASCII fallback", () => {
    const value = buildContentDisposition("舆情速报(6月).docx", "1781234_ab12cd34.docx");
    expect(value).toBe(
      `attachment; filename="1781234_ab12cd34.docx"; filename*=UTF-8''%E8%88%86%E6%83%85%E9%80%9F%E6%8A%A5%286%E6%9C%88%29.docx`,
    );
    // Header value must stay pure ASCII.
    expect(value).toMatch(/^[\x20-\x7E]+$/);
  });
});

describe("OSS V1 signing", () => {
  it("builds the canonical string for a PUT without x-oss headers", () => {
    const stringToSign = buildOssStringToSign({
      verb: "PUT",
      contentMd5: "md5==",
      contentType: "application/pdf",
      date: "Fri, 12 Jun 2026 03:00:00 GMT",
      bucket: "leadingnews",
      objectKey: "ibtai/assistant-agent/outputs/2026/6/12/1_abcdef01.pdf",
    });
    expect(stringToSign).toBe(
      "PUT\nmd5==\napplication/pdf\nFri, 12 Jun 2026 03:00:00 GMT\n" +
        "/leadingnews/ibtai/assistant-agent/outputs/2026/6/12/1_abcdef01.pdf",
    );
  });

  it("produces the documented HMAC-SHA1 base64 signature", () => {
    // Deterministic vector: hmac-sha1("secret", "data") base64.
    expect(signOssRequest("secret", "data")).toBe("mBjjMGulrCZ7XyZ5/kq9N+bNe1Q=");
  });
});

describe("uploadFileToOss", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("PUTs with signed headers and returns the custom-domain URL", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-test-"));
    const filePath = path.join(tmpDir, "report.pdf");
    await fs.writeFile(filePath, "pdf-bytes");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await uploadFileToOss({
      config: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        bucket: "leadingnews",
        endpoint: "oss-cn-beijing.aliyuncs.com",
        customDomain: "https://oss.ibtai.com",
        pathPrefix: "ibtai/assistant-agent/outputs",
        maxFileSizeMb: 100,
        allowedExtensions: ["pdf"],
      },
      localPath: filePath,
      displayName: "舆情速报.pdf",
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toMatch(
      /^https:\/\/leadingnews\.oss-cn-beijing\.aliyuncs\.com\/ibtai\/assistant-agent\/outputs\/\d{4}\/\d{1,2}\/\d{1,2}\/\d+_[0-9a-f]{8}\.pdf$/,
    );
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("PUT");
    expect(headers.Authorization).toMatch(/^OSS ak:[A-Za-z0-9+/]+=*$/);
    expect(headers["Content-Type"]).toBe("application/pdf");
    expect(headers["Content-Disposition"]).toContain("filename*=UTF-8''%E8%88%86%E6%83%85");
    expect(result.url).toBe(`https://oss.ibtai.com/${result.objectKey}`);
    expect(result.size).toBe(Buffer.byteLength("pdf-bytes"));
  });

  it("throws on non-2xx responses", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-test-"));
    const filePath = path.join(tmpDir, "x.txt");
    await fs.writeFile(filePath, "x");
    const fetchImpl = (async () => new Response("denied", { status: 403 })) as typeof fetch;

    await expect(
      uploadFileToOss({
        config: {
          accessKeyId: "ak",
          accessKeySecret: "sk",
          bucket: "b",
          endpoint: "e.example.com",
          customDomain: "https://d.example.com",
          pathPrefix: "p",
          maxFileSizeMb: 100,
          allowedExtensions: ["txt"],
        },
        localPath: filePath,
        displayName: "x.txt",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});
