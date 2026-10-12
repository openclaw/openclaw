import { execFileSync } from "node:child_process";
// Test-only GitHub transport for the real P admission producer and consumer.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { produceQualificationAdmission } from "../../scripts/release-qualification-admission.mjs";

const repository = "openclaw/openclaw";
const path = ".github/workflows/openclaw-release-prepare.yml";
const upload = "Upload immutable qualification admission";
const jobName = "Admit frozen candidate qualification";

export async function respond(args, config) {
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const selected = endpoint.slice(("repos/" + repository + "/").length);
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  const git = (argv) =>
    execFileSync("git", ["--git-dir", config.origin, ...argv], {
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
    }).trim();
  const accepted = () => JSON.parse(readFileSync(config.admissionCapturePath, "utf8"));
  // P is the main tip the helper dispatched from; it differs from the selected
  // P only when main advanced before the admission POST.
  const advancedPath = config.admissionCapturePath + ".advanced";
  const publisherSha = () =>
    existsSync(advancedPath)
      ? readFileSync(advancedPath, "utf8").trim().split("\n").at(-1)
      : config.publisherSha;
  const actor = { id: 91, login: "release-operator", type: "User" };
  const run = (active = false) => ({
    id: 321,
    run_attempt: 1,
    workflow_id: 18,
    path,
    event: "workflow_dispatch",
    head_sha: !active && config.options.admissionWrongRunSha ? config.targetSha : publisherSha(),
    head_branch: accepted().ref,
    display_title:
      "Qualification Admission " + JSON.parse(accepted().inputs.qualification_request).requestId,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: active ? "in_progress" : "completed",
    conclusion: active
      ? null
      : existsSync(config.admissionReceiptPath + ".failure")
        ? "failure"
        : "success",
    actor,
    triggering_actor: actor,
  });
  const readApi = (apiArgs, active = false) => {
    const route = apiArgs
      .find((arg) => arg.startsWith("repos/"))
      ?.slice(("repos/" + repository + "/").length);
    if (route?.startsWith("compare/")) {
      const sha = route.slice(8).split("...")[0];
      if (sha !== publisherSha()) {
        throw new Error("Q must not be subjected to P/main ancestry");
      }
      git(["merge-base", "--is-ancestor", sha, "refs/heads/main"]);
      return JSON.stringify({
        status: sha === git(["rev-parse", "refs/heads/main"]) ? "identical" : "ahead",
      });
    }
    if (route?.startsWith("contents/")) {
      const [name, sha] = route.slice(9).split("?ref=");
      const bytes = execFileSync("git", ["--git-dir", config.origin, "show", sha + ":" + name], {
        env: { ...process.env, PATH: process.env.MOCK_REAL_PATH },
      });
      return JSON.stringify({
        type: "file",
        path: name,
        encoding: "base64",
        content: bytes.toString("base64"),
        size: bytes.length,
        sha: createHash("sha1")
          .update("blob " + bytes.length + "\0")
          .update(bytes)
          .digest("hex"),
      });
    }
    if (route?.startsWith("git/ref/")) {
      const ref = "refs/" + route.slice(8);
      let sha = git(["rev-parse", ref]);
      const advanced = existsSync(advancedPath)
        ? readFileSync(advancedPath, "utf8").trim().split("\n").length
        : 0;
      if (
        ref === "refs/heads/main" &&
        !existsSync(config.admissionCapturePath) &&
        advanced < (config.options.advanceMainBeforeAdmission ?? 0)
      ) {
        // Another merge lands on main between P selection and this read.
        sha = git(["commit-tree", git(["rev-parse", sha + "^{tree}"]), "-p", sha, "-m", "later"]);
        git(["update-ref", "refs/heads/main", sha]);
        writeFileSync(advancedPath, sha + "\n", { flag: "a" });
      }
      if (
        config.options.admissionMovedRef &&
        ref === "refs/heads/main" &&
        !existsSync(config.admissionCapturePath)
      ) {
        sha = config.targetSha;
      }
      if (config.options.qualificationMovedRef && ref.startsWith("refs/heads/release-ci/")) {
        sha = publisherSha();
      }
      return JSON.stringify({ ref, object: { type: "commit", sha } });
    }
    if (route === "collaborators/release-operator/permission") {
      return JSON.stringify({
        permission: config.options.admissionRevokedActor && !active ? "read" : "write",
        user: actor,
      });
    }
    if (route === "actions/runs/321/attempts/1") {
      return JSON.stringify(run(active));
    }
    throw new Error("Unknown admission API read: " + route);
  };
  // GitHub retains one immutable uploaded archive. Build those fixture bytes once
  // after POST; separate fake API processes only read them. Live authority, source,
  // job and attempt responses remain uncached and the production verifier still runs.
  const prepareArtifact = async () => {
    const { default: JSZip } = await import("jszip");
    const receipt = readFileSync(config.admissionReceiptPath);
    const zip = new JSZip();
    zip.file("qualification-admission.json", receipt, { date: new Date("2026-01-01T00:00:00Z") });
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const metadata = {
      id: 9002,
      name: "release-qualification-admission-321-1",
      expired: false,
      created_at: "2026-09-28T00:00:02Z",
      expires_at: "2099-01-01T00:00:00Z",
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      size_in_bytes: bytes.length,
      workflow_run: { id: 321, head_sha: publisherSha() },
    };
    writeFileSync(config.admissionReceiptPath + ".zip", bytes, { flag: "wx" });
    writeFileSync(config.admissionReceiptPath + ".artifact.json", JSON.stringify(metadata), {
      flag: "wx",
    });
  };
  const artifact = () => ({
    bytes: readFileSync(config.admissionReceiptPath + ".zip"),
    metadata: JSON.parse(readFileSync(config.admissionReceiptPath + ".artifact.json", "utf8")),
  });
  if (
    method === "POST" &&
    selected === "actions/workflows/openclaw-release-prepare.yml/dispatches"
  ) {
    const payload = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    const request = JSON.parse(payload.inputs.qualification_request);
    const requestDirectory = join(config.checkout, ".artifacts", "full-release-validation");
    const requestPath =
      process.env.MOCK_REQUEST_FILE ||
      join(
        requestDirectory,
        readdirSync(requestDirectory).find((name) => name.endsWith(".json")),
      );
    const intent = JSON.parse(readFileSync(requestPath, "utf8"));
    if (
      intent.admission?.phase !== "attempted" ||
      intent.phase !== "prepared" ||
      intent.refs.workflow !== "intended" ||
      JSON.stringify(intent.admission.request) !== JSON.stringify(request) ||
      (statSync(requestPath).mode & 0o777) !== 0o600
    ) {
      throw new Error("P POST requires private exact durable admission intent before Q mutation");
    }
    writeFileSync(config.admissionCapturePath, JSON.stringify(payload));
    const producer = {
      repository,
      runId: 321,
      runAttempt: 1,
      workflowPath: path,
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: payload.ref,
      workflowFullRef: payload.ref === "main" ? "refs/heads/main" : "refs/tags/" + payload.ref,
      workflowSha: publisherSha(),
    };
    // This executes P only. Immutable Q workflow/policy blobs are returned by Git.
    let receipt;
    try {
      receipt = produceQualificationAdmission({
        request,
        producer,
        runGh: (apiArgs) => readApi(apiArgs, true),
      });
    } catch (error) {
      writeFileSync(config.admissionReceiptPath + ".failure", String(error));
      console.log("HTTP/2.0 204 No Content\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    writeFileSync(config.admissionReceiptPath, JSON.stringify(receipt));
    await prepareArtifact();
    if (config.options.advanceMainAfterAdmission) {
      const next = git([
        "commit-tree",
        git(["rev-parse", publisherSha() + "^{tree}"]),
        "-p",
        publisherSha(),
        "-m",
        "test: later main",
      ]);
      git(["update-ref", "refs/heads/main", next]);
    }
    if (config.options.admissionAcceptedFailure) {
      console.error("connection reset by peer after admission accepted");
      process.exitCode = 1;
    } else {
      console.log("HTTP/2.0 204 No Content\r\nContent-Length: 0\r\n\r\n");
    }
  } else if (selected === "actions/workflows/openclaw-release-prepare.yml") {
    console.log(JSON.stringify({ id: 18, path }));
  } else if (selected === "actions/workflows/18/runs") {
    console.log(
      JSON.stringify({
        total_count: existsSync(config.admissionCapturePath) ? 1 : 0,
        workflow_runs: existsSync(config.admissionCapturePath) ? [run()] : [],
      }),
    );
  } else if (selected === "actions/runs/321/attempts/1/jobs?per_page=100") {
    console.log(
      JSON.stringify({
        total_count: 1,
        jobs: [
          {
            id: 501,
            name: jobName,
            run_id: 321,
            run_attempt: 1,
            head_sha: publisherSha(),
            status: "completed",
            conclusion: "success",
            steps: [
              {
                name: upload,
                status: "completed",
                conclusion: config.options.admissionFailedUpload ? "failure" : "success",
                started_at: "2026-09-28T00:00:01Z",
                completed_at: "2026-09-28T00:00:03Z",
              },
            ],
          },
        ],
      }),
    );
  } else if (selected.startsWith("actions/runs/321/artifacts?")) {
    const { metadata } = artifact();
    console.log(JSON.stringify({ total_count: 1, artifacts: [metadata] }));
  } else if (selected.startsWith("actions/artifacts/9002")) {
    const { metadata, bytes } = artifact();
    if (selected.endsWith("/zip")) {
      process.stdout.write(bytes);
    } else {
      console.log(JSON.stringify(metadata));
    }
  } else {
    console.log(readApi(args));
  }
}
