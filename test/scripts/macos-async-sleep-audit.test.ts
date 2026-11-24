import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Synthetic Mach-O + disassembler I/O exercise the real audit entry point on any host.
// Captured release-binary replay and native macOS qualification remain separate proof.
const program = String.raw`
import contextlib, importlib.util, io, json, struct, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sleep_audit", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

ROOT = "_$ss5ClockPsE5sleep3for9tolerancey8DurationQz_AGSgtYaKFs010ContinuousA0V_Tgq5"
TARGET_ROOT = ROOT.replace("Tgq5", "Tg5")
TARGET_NAME = TARGET_ROOT + "TY2_"
VM = 0x10146b000
TARGET = 0x10146c038
BRANCH = 0x101470350
ENTRY = BRANCH - 16
DESCRIPTOR = VM + 0x5000

class AuditTests(unittest.TestCase):
    def run_audit(self, allocation=128, state="register", target_name=TARGET_NAME,
                  word=0x17ffef3a, transfer="b", source_name=ROOT + "TY2_",
                  branch_operand=TARGET_NAME, origin_offset=32):
        symbols = [(DESCRIPTOR, ROOT + "Tu"), (ENTRY, source_name),
                   (DESCRIPTOR + 8, TARGET_ROOT + "Tu"), (VM, TARGET_ROOT)]
        # The encoded target is neither the first nor last of eight identical local names.
        symbols += [(TARGET + i * 0x100, target_name) for i in range(-3, 5)]
        symbols += [(BRANCH + 4, "_end")]
        strings = bytearray(b"\0")
        table = bytearray()
        for address, name in symbols:
            table += struct.pack("<IBBHQ", len(strings), 0x0e, 1, 0, address)
            strings += name.encode() + b"\0"
        data = bytearray(0x6000)
        struct.pack_into("<8I", data, 0, 0xfeedfacf, 0x100000c, 0, 2, 2, 96, 0, 0)
        struct.pack_into("<II16s4Q4I", data, 32, 0x19, 72, b"__TEXT",
                         VM, len(data), 0, len(data), 7, 5, 0, 0)
        struct.pack_into("<6I", data, 104, 2, 24, len(data), len(symbols),
                         len(data) + len(table), len(strings))
        struct.pack_into("<iI", data, DESCRIPTOR - VM, ENTRY - DESCRIPTOR, allocation)
        struct.pack_into("<iI", data, DESCRIPTOR + 8 - VM, VM - DESCRIPTOR - 8, 256)
        struct.pack_into("<I", data, BRANCH - VM, word)
        data += table + strings
        bodies = {
            VM: [("str", "x0, [x22, #16]"), ("ldr", "x0, [x22, #8]"), ("br", "x0")],
            ENTRY: [("mov", "x19, x22"), ("str", "x19, [sp, #16]"),
                    ("str", f"x19, [x19, #{origin_offset}]"), ("add", "x22, x22, #16"),
                    (transfer, branch_operand)],
        }
        target = {
            "register": [("str", "x0, [x19, #112]")],
            "stack": [("ldr", "x20, [sp, #16]"), ("str", "x0, [x20, #112]")],
            "slot": [("ldr", "x20, [x19, #32]"), ("str", "x0, [x20, #112]")],
            "context": [("str", "x0, [x22, #96]")],
        }[state]
        # Exercise a conditional path in the tail target as well as its fallthrough.
        target += [("cbz", f"x1, {TARGET + (len(target) + 1) * 4:#x}"),
                   ("ldr", "x0, [x19, #8]"), ("br", "x0")]
        bodies[TARGET] = target
        for i in range(-3, 5):
            if i != 0:
                bodies[TARGET + i * 0x100] = [("ret", "")]
        disassembly = "\n".join(
            f"{address + index * 4:x}: 00 00 00 00 {op} {args}"
            for address, instructions in bodies.items()
            for index, (op, args) in enumerate(instructions)
        )
        def disassemble(command, **kwargs):
            self.assertEqual(command[:2], ["xcrun", "llvm-objdump"])
            return subprocess.CompletedProcess(command, 0, stdout=disassembly, stderr="")
        with tempfile.TemporaryDirectory(prefix="sleep-audit-") as directory:
            binary = Path(directory) / "OpenClaw"
            binary.write_bytes(data)
            output = io.StringIO()
            with patch.object(sys, "argv", [str(spec.origin), str(binary)]), \
                 patch.object(m.subprocess, "run", side_effect=disassemble), \
                 contextlib.redirect_stdout(output):
                status = m.main()
            return status, json.loads(output.getvalue())

    def test_direct_tail_uses_concrete_target_and_preserves_origin_state(self):
        for state in ["register", "stack", "slot", "context"]:
            with self.subTest(state=state):
                status, report = self.run_audit(state=state)
                self.assertEqual(status, 0, report)
                origin, other = report["frames"]
                self.assertEqual(origin["descriptor"], hex(DESCRIPTOR))
                self.assertEqual(origin["entry"], hex(ENTRY))
                self.assertEqual(origin["allocation_bytes"], 128)
                self.assertEqual(origin["required_bytes"], 120)
                self.assertEqual(origin["continuations"], [hex(TARGET), hex(ENTRY)])
                self.assertEqual(other["allocation_bytes"], 256)

    def test_historical_112_byte_allocation_still_fails_120_byte_store(self):
        status, report = self.run_audit(allocation=112)
        self.assertEqual(status, 1, report)
        self.assertEqual(report["result"], "fail")
        self.assertFalse(report["frames"][0]["in_bounds"])
        self.assertEqual(report["frames"][0]["allocation_bytes"], 112)
        self.assertEqual(report["frames"][0]["required_bytes"], 120)
        self.assertTrue(report["frames"][1]["in_bounds"])

    def test_stores_before_the_tail_remain_in_the_origin_frame(self):
        status, report = self.run_audit(origin_offset=128)
        self.assertEqual(status, 1, report)
        self.assertEqual(report["frames"][0]["required_bytes"], 136)
        self.assertEqual(report["frames"][0]["largest_stores"][0]["address"], hex(ENTRY + 8))

    def test_unknown_transfers_fail_closed(self):
        cases = [
            {"target_name": TARGET_NAME.replace("Continuous", "Suspending")},
            {"target_name": TARGET_NAME.replace("Tg5", "Tg4")},
            {"target_name": TARGET_NAME.replace("TY2_", "TY1_")},
            {"target_name": TARGET_NAME.replace("TY2_", "TQ2_")},
            {"target_name": "_unknown"},
            {"source_name": ROOT},
            {"word": 0x97ffef3a},  # BL is not a tail B.
            {"word": 0x17ffef3b},  # Target is inside a function, not a known continuation.
            {"transfer": "br", "branch_operand": "x9"},
        ]
        for case in cases:
            with self.subTest(case=case):
                status, report = self.run_audit(**case)
                self.assertEqual(status, 2, report)
                self.assertEqual(report["result"], "unsupported")
                if case.get("word") == 0x97ffef3a:
                    expected = f"invalid direct branch encoding at {BRANCH:#x}"
                elif case.get("transfer") == "br":
                    expected = f"unsupported async transfer at {BRANCH:#x}"
                else:
                    address = TARGET + (4 if case.get("word") == 0x17ffef3b else 0)
                    expected = f"continuation {address:#x} is not a known sleep function"
                self.assertIn(expected, report["error"])

unittest.main(argv=["sleep-audit"], verbosity=2)
`;

it("audits concrete Swift tail continuations without losing frame ownership or accepting unknown transfers", () => {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      fileURLToPath(
        new URL("../../apps/macos/scripts/audit-async-sleep-frames.py", import.meta.url),
      ),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
