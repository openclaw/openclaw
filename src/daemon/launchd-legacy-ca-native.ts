import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { z } from "zod";
import { execFileUtf8 } from "./exec-file.js";

// Read-only Security.framework calls through the macOS-provided interpreter.
// No explicit anchors: they would bypass native distrust of the proposed root.
const TRUST_INSPECTION_SCRIPT = String.raw`
ObjC.import("Foundation");
ObjC.import("Security");
ObjC.bindFunction("SecTrustSettingsCreateExternalRepresentation", ["int", ["int", "id *"]]);
ObjC.bindFunction("SecTrustSettingsCopyCertificates", ["int", ["int", "id *"]]);
ObjC.bindFunction("SecCertificateCopyData", ["id", ["id"]]);
ObjC.bindFunction("SecCertificateCreateWithData", ["id", ["void *", "id"]]);
ObjC.bindFunction("SecPolicyCreateBasicX509", ["id", []]);
ObjC.bindFunction("SecTrustCreateWithCertificates", ["int", ["id", "id", "id *"]]);
ObjC.bindFunction("SecTrustEvaluateWithError", ["bool", ["id", "id *"]]);
ObjC.bindFunction("SecTrustCopyResult", ["id", ["id"]]);
ObjC.bindFunction("SecTrustSetNetworkFetchAllowed", ["int", ["id", "bool"]]);
ObjC.bindFunction("SecTrustGetCertificateCount", ["long", ["id"]]);
function run(argv) {
  if (argv[0] === "trust-settings") {
    const domains = [];
    for (let domain = 0; domain < 3; domain++) {
      const external = Ref();
      const exportStatus = $.SecTrustSettingsCreateExternalRepresentation(domain, external);
      let exportVersion = null, records = null;
      if (exportStatus === 0) {
        const plist = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError(external[0], 0, null, null);
        exportVersion = Number(ObjC.unwrap(plist.objectForKey("trustVersion")));
        const list = plist.objectForKey("trustList");
        records = ObjC.deepUnwrap(list.allKeys).map(function(key) {
          const settings = ObjC.deepUnwrap(list.objectForKey(key).objectForKey("trustSettings")) || [];
          if (!Array.isArray(settings)) throw new Error("Unknown native trust settings");
          let deny = false;
          settings.forEach(function(setting) {
            if (!setting || typeof setting !== "object" || Array.isArray(setting)) throw new Error("Unknown native trust record");
            const result = setting.kSecTrustSettingsResult;
            if (result !== undefined && [1, 2, 3, 4].indexOf(result) === -1) throw new Error("Unknown native trust result");
            if (result === 3) deny = true;
          });
          return {certificateSHA1: key, deny: deny};
        });
      }
      const certs = Ref();
      const certificatesStatus = $.SecTrustSettingsCopyCertificates(domain, certs);
      let certificateDERBase64 = null;
      if (certificatesStatus === 0) {
        certificateDERBase64 = [];
        const count = Number(ObjC.unwrap(certs[0].count));
        for (let i = 0; i < count; i++) {
          certificateDERBase64.push(ObjC.unwrap($.SecCertificateCopyData(certs[0].objectAtIndex(i)).base64EncodedStringWithOptions(0)));
        }
      }
      domains.push({domain: domain, exportStatus: exportStatus, exportVersion: exportVersion, records: records, certificatesStatus: certificatesStatus, certificateDERBase64: certificateDERBase64});
    }
    return JSON.stringify({domains: domains});
  }
  if (argv[0] !== "evaluate" || argv.length !== 2) throw new Error("Unknown certificate inspection");
  const cert = $.SecCertificateCreateWithData(null, $.NSData.alloc.initWithBase64EncodedStringOptions(argv[1], 0));
  if (!cert) throw new Error("Invalid certificate");
  const out = Ref();
  const createStatus = $.SecTrustCreateWithCertificates($.NSArray.arrayWithObject(cert), $.SecPolicyCreateBasicX509(), out);
  if (createStatus !== 0) throw new Error("Native trust creation failed");
  const trust = out[0];
  const networkStatus = $.SecTrustSetNetworkFetchAllowed(trust, false);
  if (networkStatus !== 0) throw new Error("Native offline inspection failed");
  const error = Ref();
  const ok = $.SecTrustEvaluateWithError(trust, error);
  return JSON.stringify({createStatus: createStatus, networkStatus: networkStatus, certificateCount: String($.SecTrustGetCertificateCount(trust)), ok: ok, errorCode: error[0] ? Number(ObjC.unwrap(error[0].code)) : null, result: ObjC.deepUnwrap($.SecTrustCopyResult(trust))});
}`;

const trustSettingsSchema = z.strictObject({
  domains: z
    .array(
      z.strictObject({
        domain: z.number().int().min(0).max(2),
        exportStatus: z.literal(0),
        exportVersion: z.literal(1),
        records: z.array(
          z.strictObject({
            certificateSHA1: z.string().regex(/^[a-f0-9]{40}$/iu),
            deny: z.boolean(),
          }),
        ),
        certificatesStatus: z.union([z.literal(0), z.literal(-25263)]),
        certificateDERBase64: z.array(z.string()).nullable(),
      }),
    )
    .length(3),
});

export function certificatePublicKeyHash(certificate: X509Certificate): string {
  // Named and explicit EC parameters can encode the same key differently.
  // Unsupported JWK encodings must stay ambiguous, never fall back to raw SPKI.
  const canonicalKey = createPublicKey({
    key: certificate.publicKey.export({ format: "jwk" }),
    format: "jwk",
  });
  return createHash("sha256")
    .update(canonicalKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

async function inspectNativeTrust(args: string[]): Promise<unknown> {
  const result = await execFileUtf8(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", TRUST_INSPECTION_SCRIPT, ...args],
    { timeout: 15_000 },
  );
  if (result.code !== 0 || result.termination !== "exit") {
    throw new Error("macOS trust inspection unavailable");
  }
  return JSON.parse(result.stdout);
}

/** Policy/application-scoped Deny can be invisible to Basic X509 evaluation. */
export async function readNativeDistrustedPublicKeys(): Promise<Set<string>> {
  const { domains } = trustSettingsSchema.parse(await inspectNativeTrust(["trust-settings"]));
  if (new Set(domains.map(({ domain }) => domain)).size !== 3) {
    throw new Error("Incomplete macOS trust domains");
  }
  const denied = new Set<string>();
  for (const domain of domains) {
    if (
      (domain.certificatesStatus === 0) !== (domain.certificateDERBase64 !== null) ||
      (domain.certificatesStatus === -25263 && domain.records.length > 0)
    ) {
      throw new Error("Incomplete macOS trust certificates");
    }
    const certificates = new Map<string, X509Certificate>();
    for (const der of domain.certificateDERBase64 ?? []) {
      const certificate = new X509Certificate(Buffer.from(der, "base64"));
      certificates.set(createHash("sha1").update(certificate.raw).digest("hex"), certificate);
    }
    for (const record of domain.records) {
      if (!record.deny) {
        continue;
      }
      const certificate = certificates.get(record.certificateSHA1.toLowerCase());
      if (!certificate) {
        throw new Error("Unresolved macOS distrust certificate");
      }
      denied.add(certificatePublicKeyHash(certificate));
    }
  }
  return denied;
}

const evaluationSchema = z.object({
  createStatus: z.literal(0),
  networkStatus: z.literal(0),
  certificateCount: z.literal("1"),
  ok: z.boolean(),
  errorCode: z.number().int().nullable(),
  result: z.object({
    TrustResultValue: z.number().int(),
    TrustResultDetails: z.tuple([z.record(z.string(), z.unknown())]),
  }),
});

/** Accept only clean native trust or the exact expected private-root non-anchor. */
export async function isNativeRootEligible(certificate: X509Certificate): Promise<boolean> {
  const result = evaluationSchema.parse(
    await inspectNativeTrust(["evaluate", certificate.raw.toString("base64")]),
  );
  const detail = result.result.TrustResultDetails[0];
  if (
    result.ok &&
    result.errorCode === null &&
    [1, 4].includes(result.result.TrustResultValue) &&
    Object.keys(detail).length === 0
  ) {
    return true;
  }
  return (
    !result.ok &&
    result.errorCode === -67843 &&
    result.result.TrustResultValue === 5 &&
    Object.keys(detail).length === 2 &&
    detail.AnchorTrusted === false &&
    Array.isArray(detail.StatusCodes) &&
    detail.StatusCodes.length === 1 &&
    detail.StatusCodes[0] === -2147409622
  );
}
