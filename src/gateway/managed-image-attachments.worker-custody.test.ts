import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import * as brokerReply from "../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedOutgoingMediaBlocks } from "./managed-image-attachments.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";

describe("managed media worker custody", () => {
  it("retains committed bytes without accepting a result after its database admission closes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-retirement" },
      async (state) => {
        const bytes = createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 });
        const accepted = vi.fn();
        const result = withChannelReadAuthority(
          () => {},
          async () => {
            const blocks = await createManagedOutgoingMediaBlocks({
              sessionKey: "agent:main:custody",
              agentId: "main",
              stateDir: state.stateDir,
              items: [
                { url: `data:image/png;base64,${bytes.toString("base64")}`, trustedLocal: false },
              ],
            });
            await closeOpenClawStateDatabaseByPathAsync(
              state.statePath("state", "openclaw.sqlite"),
            );
            return blocks;
          },
          undefined,
          accepted,
        );
        const outcome = await result.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isStateDatabaseReadAdmissionInvalidatedError(outcome)).toBe(true);
        expect(accepted).not.toHaveBeenCalled();
        const entries = await listManagedImageRecordEntries({ stateDir: state.stateDir });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.cleanupPending).toBe(false);
        const record = entries[0]!.record;
        expect(
          await fs.readFile(
            path.join(
              record.original.mediaRoot,
              record.original.mediaSubdir,
              record.original.mediaId,
            ),
          ),
        ).toEqual(bytes);
      },
    );
  });

  it("rejects a replaced file without deleting either inode after record custody is delegated", async () => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-replacement" },
      async (state) => {
        const bytes = createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 });
        const accepted = vi.fn();
        const displaced = state.statePath("displaced-original.png");
        let originalPath: string | undefined;
        const result = withChannelReadAuthority(
          () => {},
          async () => {
            const blocks = await createManagedOutgoingMediaBlocks({
              sessionKey: "agent:main:custody",
              agentId: "main",
              stateDir: state.stateDir,
              items: [
                { url: `data:image/png;base64,${bytes.toString("base64")}`, trustedLocal: false },
              ],
            });
            const entries = await listManagedImageRecordEntries({ stateDir: state.stateDir });
            expect(entries).toHaveLength(1);
            const record = entries[0]!.record;
            originalPath = path.join(
              record.original.mediaRoot,
              record.original.mediaSubdir,
              record.original.mediaId,
            );
            await fs.rename(originalPath, displaced);
            await fs.writeFile(originalPath, "synthetic replacement");
            return blocks;
          },
          undefined,
          accepted,
        );
        await expect(result).rejects.toThrow("Media output no longer names the created file");
        expect(accepted).not.toHaveBeenCalled();
        expect(originalPath).toBeDefined();
        if (!originalPath) {
          throw new Error("Managed media fixture did not commit a file");
        }
        expect(await fs.readFile(originalPath, "utf8")).toBe("synthetic replacement");
        expect(await fs.readFile(displaced)).toEqual(bytes);
        expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
          { cleanupPending: true, record: { retentionClass: "transient", messageId: null } },
        ]);
      },
    );
  });

  it.each([
    "refused commit",
    "revoked after commit",
    "lost ordinary reply",
    "lost native receipt",
  ] as const)("settles the original file and record after a %s", async (failure) => {
    await withOpenClawTestState(
      { layout: "state-only", label: "managed-media-custody" },
      async (state) => {
        await listManagedImageRecordEntries({ stateDir: state.stateDir });
        const bytes = createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 });
        const revoked = new Error("Synthetic channel authority revoked");
        let active = true;
        let nativeReplies = 0;
        let refused = false;
        const accepted = vi.fn();
        const assertCurrent = () => {
          if (!active) {
            throw revoked;
          }
        };
        const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
        const admissionSpy = vi
          .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) => {
            const admission = createAdmission((request, grant) => {
              if (failure === "refused commit" && request.stage === "commit") {
                refused = true;
                active = false;
              }
              admit(request, grant);
            }, attachment);
            if (failure !== "lost native receipt") {
              return admission;
            }
            // Native work still executes and joins; only its retained facts are unavailable
            // to the media owner, alongside the independently corrupted ordinary reply.
            return new Proxy(admission, {
              get(target, key, receiver) {
                if (key === "committed" || key === "settlement") {
                  return undefined;
                }
                return Reflect.get(target, key, receiver);
              },
            });
          });
        const receive = brokerReply.receiveSqliteWorkerReply;
        const replySpy = vi
          .spyOn(brokerReply, "receiveSqliteWorkerReply")
          .mockImplementation((slot, reply, owner) => {
            if (
              slot.current?.request.type === "execute" &&
              reply.ok &&
              !reply.transfer &&
              !reply.input
            ) {
              const command: unknown = deserialize(slot.current.request.input);
              if (isRecord(command) && command.type === "managedImages.insert") {
                nativeReplies++;
                if (failure === "revoked after commit") {
                  active = false;
                }
                if (failure === "lost ordinary reply" || failure === "lost native receipt") {
                  return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
                }
              }
            }
            return receive(slot, reply, owner);
          });
        try {
          const outcome = await withChannelReadAuthority(
            assertCurrent,
            () =>
              createManagedOutgoingMediaBlocks({
                sessionKey: "agent:main:custody",
                agentId: "main",
                stateDir: state.stateDir,
                items: [
                  { url: `data:image/png;base64,${bytes.toString("base64")}`, trustedLocal: false },
                ],
                assertCurrent,
              }),
            undefined,
            accepted,
          ).then(
            (blocks) => ({ blocks }),
            (error: unknown) => ({ error }),
          );
          // Stop injecting transport faults before independently reading the persisted result.
          replySpy.mockRestore();
          admissionSpy.mockRestore();
          const entries = await listManagedImageRecordEntries({ stateDir: state.stateDir });
          const originals = state.statePath("media", "outgoing", "originals");
          if (failure === "lost ordinary reply" || failure === "lost native receipt") {
            expect(nativeReplies).toBe(1);
            expect(entries).toHaveLength(1);
            const record = entries[0]!.record;
            expect(record).toMatchObject({ retentionClass: "transient", messageId: null });
            expect(
              await fs.readFile(
                path.join(
                  record.original.mediaRoot,
                  record.original.mediaSubdir,
                  record.original.mediaId,
                ),
              ),
            ).toEqual(bytes);
            if (failure === "lost ordinary reply") {
              expect(outcome).toHaveProperty("blocks");
              expect(accepted).toHaveBeenCalledOnce();
            } else {
              expect(outcome).toHaveProperty("error");
              expect(accepted).not.toHaveBeenCalled();
            }
          } else {
            expect(outcome).toEqual({ error: revoked });
            expect(accepted).not.toHaveBeenCalled();
            expect(entries).toEqual([]);
            expect(await fs.readdir(originals)).toEqual([]);
            expect(refused).toBe(failure === "refused commit");
            expect(nativeReplies).toBe(failure === "refused commit" ? 0 : 1);
          }
        } finally {
          replySpy.mockRestore();
          admissionSpy.mockRestore();
        }
      },
    );
  });
});
