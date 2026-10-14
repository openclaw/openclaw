import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { runSqliteWorkerAttachmentFramingProof } from "./sqlite-worker-operation-attachment.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("shares the queued attachment only inside its active operation scope", async () => {
  const admission = createSqliteWorkerOperationAdmission(() => {}, { label: "scope-fixture" });
  try {
    const afterScope = withSqliteWorkerOperationAdmission({ port: admission.port }, () => {
      const attachment = takeSqliteWorkerOperationAdmissionAttachment();
      expect(attachment).toEqual({ label: "scope-fixture" });
      expect(takeSqliteWorkerOperationAdmissionAttachment()).toBe(attachment);
      return Promise.resolve().then(() => takeSqliteWorkerOperationAdmissionAttachment());
    });
    await expect(afterScope).rejects.toThrow("requires its retained admission");
  } finally {
    admission.finish();
  }
});

it("retains queued attachments until complete inline and framed worker commands execute", async () => {
  const proof = await runSqliteWorkerAttachmentFramingProof(
    path.join(dirs.make("sqlite-attachment-framing-"), "unused.sqlite"),
  );
  expect(proof).toMatchObject({
    admissionRequests: 2,
    backendClosed: true,
    databaseCreated: true,
  });
});
