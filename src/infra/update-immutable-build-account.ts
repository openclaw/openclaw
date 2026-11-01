import os from "node:os";
import path from "node:path";
import { getMinimalServicePathPartsFromEnv } from "../daemon/service-env.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { statIfExists } from "./path-existence.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
import { readImmutableService } from "./update-immutable-service.js";

const provisioning = "https://docs.openclaw.ai/cli/update#immutable-release-installations";

/** Resolve the fallback before the update owner creates any control or staging files. */
export async function resolveImmutableOperatorBuildAccount(descriptor: ImmutableInstallDescriptor) {
  if (process.geteuid?.() !== 0) {
    const operator = os.userInfo();
    if (operator.uid > 0) {
      return {
        account: operator.username,
        uid: operator.uid,
        gid: process.getegid?.() ?? operator.gid,
        path: process.env.PATH ?? "/usr/bin:/bin",
      };
    }
  } else {
    const lookup = async (key: string) => {
      const result = await runCommandWithTimeout(["/usr/bin/getent", "passwd", key], {
        cwd: descriptor.root,
        timeoutMs: 5_000,
        baseEnv: {},
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      if (result.code !== 0) {
        return undefined;
      }
      const fields = result.stdout.trim().split(":");
      const [account, , uid, gid, , home] = fields;
      if (
        fields.length !== 7 ||
        !account ||
        !/^\d+$/u.test(uid ?? "") ||
        !/^\d+$/u.test(gid ?? "") ||
        !home ||
        !path.isAbsolute(home)
      ) {
        throw new Error(`Cannot resolve immutable build account ${key}; see ${provisioning}.`);
      }
      return { account, uid: Number(uid), gid: Number(gid), home };
    };
    let owner = await lookup(descriptor.service.account);
    if (!owner || owner.uid === 0) {
      owner = undefined;
      for (const directory of [descriptor.root, descriptor.service.stateDir]) {
        const stat = await statIfExists(directory);
        if (stat?.isDirectory() && stat.uid > 0) {
          const candidate = await lookup(String(stat.uid));
          if (candidate?.uid === stat.uid) {
            owner = candidate;
            break;
          }
        }
      }
    }
    if (owner && owner.uid > 0) {
      const { command } = await readImmutableService(
        descriptor.service,
        descriptor.root,
        descriptor.current.path,
        descriptor.runtime.path,
      );
      return {
        account: owner.account,
        uid: owner.uid,
        gid: owner.gid,
        path:
          command.environment?.PATH ||
          getMinimalServicePathPartsFromEnv({
            platform: "linux",
            home: owner.home,
            env: command.environment ?? {},
            extraDirs: [path.dirname(descriptor.runtime.path)],
          }).join(":"),
      };
    }
  }
  throw new Error(
    `No non-root immutable build owner could be determined; no changes were made. Run openclaw update as the service user, or provision the isolated build account: ${provisioning}.`,
  );
}
