import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Exercise the stdlib driver with fake tools/frames, never models, Swift, or network.
const program = String.raw`
import base64, hashlib, importlib.util, io, json, os, signal, stat, struct, sys, tempfile, time, unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("mlx_proof", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openclaw-mlx-proof-test-")
        self.root = Path(self.temp.name)
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.artifacts = self.root / "proof"
        self.artifacts.mkdir()
        self.proof = m.Proof(self.root, self.scratch, self.artifacts, m.Budget(time.monotonic()))
        self.platform = self.root / "platform-T"
        self.platform.mkdir()
        self.proof.platform_temp = self.platform
        self.real_hosted, self.real_platform = m.require_hosted_ci, m.validate_platform_temp
        self.hosted_patch = patch.object(m,"require_hosted_ci")
        self.platform_patch = patch.object(m,"validate_platform_temp",return_value=self.platform)
        self.hosted_patch.start()
        self.platform_patch.start()
        self.addCleanup(self.hosted_patch.stop)
        self.addCleanup(self.platform_patch.stop)
        self.proof.admit_platform_temp = lambda binary: None

    def tearDown(self):
        self.proof.close()
        self.temp.cleanup()

    def test_fragmented_frames_and_length_guards(self):
        packet = m.frame({"type": "ready"}) + m.frame({"type": "completed", "id": "a"})
        buffer = bytearray()
        events = []
        for byte in packet:
            buffer.append(byte)
            events += m.decode_frames(buffer)
        self.assertEqual(events, [{"type": "ready"}, {"type": "completed", "id": "a"}])
        self.assertEqual(buffer, b"")
        for length in [0, m.FRAME_LIMIT + 1]:
            with self.assertRaisesRegex(RuntimeError, "frame length"):
                m.decode_frames(bytearray(struct.pack(">I", length)))

    def test_hosted_guard_refuses_before_discovery_compilation_or_profile_io(self):
        admitted={"GITHUB_ACTIONS":"true","GITHUB_REPOSITORY":"openclaw/openclaw","GITHUB_EVENT_NAME":"workflow_dispatch","RUNNER_ENVIRONMENT":"github-hosted"}
        with patch.object(m.sys,"platform","darwin"),patch.object(m,"require_hosted_ci",self.real_hosted):
            for update in [{"RUNNER_ENVIRONMENT":""},{"RUNNER_ENVIRONMENT":"self-hosted"},{"GITHUB_REPOSITORY":"foreign/repo"},{"GITHUB_EVENT_NAME":"pull_request"}]:
                with patch.dict(os.environ,{**admitted,**update}),patch.object(Path,"write_text",side_effect=AssertionError("unexpected IO")),patch.object(Path,"read_bytes",side_effect=AssertionError("unexpected profile IO")):
                    with self.assertRaisesRegex(RuntimeError,"github-hosted"):
                        self.proof.foundation_admission()
                    with self.assertRaisesRegex(RuntimeError,"github-hosted"):
                        self.proof.sandbox(["fixture"],online=True)
            with patch.dict(os.environ,admitted):
                self.real_hosted()

    def test_platform_directory_validation_rejects_parent_cache_uid_mode_and_symlink(self):
        good="/private/var/folders/ab/test-owned-user/T"
        def validate(path,mode=stat.S_IFDIR|0o700,uid=501):
            info=SimpleNamespace(st_mode=mode,st_uid=uid,st_dev=1,st_ino=2)
            with patch.object(Path,"lstat",return_value=info),patch.object(Path,"resolve",return_value=Path(path)),patch.object(m.os,"geteuid",return_value=501):
                return self.real_platform(path)
        self.assertEqual(validate(good),Path(good))
        for path in ["/tmp","/private/tmp","/private/var/folders/ab/test-owned-user","/private/var/folders/ab/test-owned-user/C","/private/var/folders/ab/test-owned-user/0"]:
            with self.assertRaises(RuntimeError):validate(path)
        for mode,uid in [(stat.S_IFLNK|0o700,501),(stat.S_IFREG|0o700,501),(stat.S_IFDIR|0o755,501),(stat.S_IFDIR|0o1700,501),(stat.S_IFDIR|0o700,502)]:
            with self.assertRaises(RuntimeError):validate(good,mode,uid)
        info=SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=0,st_dev=1,st_ino=2)
        with patch.object(Path,"lstat",return_value=info),patch.object(Path,"resolve",return_value=Path(good)),patch.object(m.os,"geteuid",return_value=0):
            with self.assertRaises(RuntimeError):self.real_platform(good)

    def test_platform_discovery_is_quiet_identity_bound_and_honestly_not_task_owned(self):
        raw={"mode":"platform-temp","pid":99,"ok":True,"temporary":"/private/var/folders/ab/private-user/T"}
        child=SimpleNamespace(process=SimpleNamespace(pid=99),joined=lambda:True,capture_overflow=False,stdout=json.dumps(raw).encode())
        calls=[]
        self.proof.quiet_capture=lambda argv,seconds,env: calls.append((argv,seconds,env)) or {"code":0,"failure":None,"child":child}
        with patch.dict(os.environ,{"RUNNER_ENVIRONMENT":"github-hosted"}):
            m.Proof.admit_platform_temp(self.proof,Path("fixture"))
        self.assertEqual(calls[0][0][1],"platform-temp")
        self.assertEqual(calls[0][1],10)
        metadata=self.proof.result["platformStaging"]
        self.assertEqual(metadata["runnerEnvironment"],"github-hosted")
        self.assertFalse(metadata["exclusiveTaskDirectory"])
        self.assertFalse(metadata["aclIsolationProven"])
        self.assertNotIn("private-user",json.dumps(self.proof.result))

    def test_destination_cleanup_verifies_only_exact_created_file_and_keeps_siblings(self):
        target=self.platform/"hf-download-test.tmp"
        sibling=self.platform/"framework-owned-other.tmp"
        data=b"x"*680
        target.write_bytes(data)
        sibling.write_bytes(b"preserve")
        pending={"path":target,"retired":False}
        child=SimpleNamespace(joined=lambda:True)
        expected=(680,hashlib.sha1(b"blob 680\0"+data).hexdigest())
        with patch.dict(m.FILES,{"config.json":expected}):
            self.assertEqual(self.proof.cleanup_foundation_destination(pending,child,True),"removed-verified-file")
        self.assertTrue(pending["retired"])
        self.assertFalse(target.exists())
        self.assertEqual(sibling.read_bytes(),b"preserve")
        self.assertEqual(self.proof.cleanup_foundation_destination({"path":target,"retired":False},child,False),"not-created")

    def test_destination_unknown_identity_symlink_or_custody_retains_file(self):
        target=self.platform/"hf-download-test.tmp"
        target.write_bytes(b"wrong")
        for child in [SimpleNamespace(joined=lambda:False),SimpleNamespace(joined=lambda:True)]:
            pending={"path":target,"retired":False}
            with self.assertRaises(m.CaptureCustodyError):
                self.proof.cleanup_foundation_destination(pending,child,True)
            self.assertFalse(pending["retired"])
            self.assertTrue(target.exists())
        target.unlink()
        sibling=self.platform/"other"
        sibling.write_bytes(b"preserve")
        target.symlink_to(sibling)
        with self.assertRaises(m.CaptureCustodyError):
            self.proof.cleanup_foundation_destination({"path":target,"retired":False},SimpleNamespace(joined=lambda:True),True)
        self.assertTrue(target.is_symlink())
        self.assertEqual(sibling.read_bytes(),b"preserve")

    def test_existing_or_symlink_destination_refuses_before_profile_or_child(self):
        target=self.platform/"hf-download-preexisting.tmp"
        sibling=self.platform/"preserved.tmp"
        sibling.write_bytes(b"preserve")
        self.proof.sandbox=lambda *args,**kwargs: (_ for _ in ()).throw(AssertionError("unexpected profile IO"))
        for kind in ["file","symlink","dangling-symlink"]:
            if kind=="file":target.write_bytes(b"preserve existing")
            else:target.symlink_to(sibling if kind=="symlink" else self.platform/"missing")
            with patch.object(m.uuid,"uuid4",return_value="preexisting"):
                with self.assertRaisesRegex(RuntimeError,"already exists"):
                    self.proof.foundation_attempt(Path("fixture"),"download")
            self.assertEqual(self.proof.children,[])
            self.assertEqual(self.proof.platform_destinations,[])
            self.assertEqual(sibling.read_bytes(),b"preserve")
            self.assertTrue(target.exists() or target.is_symlink())
            target.unlink()

    def test_alias_written_destination_is_retired_by_exact_parent_selected_path(self):
        alias=self.root/"platform-alias"
        alias.symlink_to(self.platform,target_is_directory=True)
        target=self.platform/"hf-download-selected.tmp"
        sibling=self.platform/"preserved.tmp"
        sibling.write_bytes(b"preserve")
        data=b"x"*680
        (alias/target.name).write_bytes(data)
        pending={"path":target,"retired":False}
        expected=(680,hashlib.sha1(b"blob 680\0"+data).hexdigest())
        with patch.dict(m.FILES,{"config.json":expected}):
            self.assertEqual(self.proof.cleanup_foundation_destination(pending,SimpleNamespace(joined=lambda:True),True),"removed-verified-file")
        self.assertTrue(pending["retired"])
        self.assertFalse(target.exists())
        self.assertFalse((alias/target.name).exists())
        self.assertTrue(alias.is_symlink())
        self.assertEqual(sibling.read_bytes(),b"preserve")

    def test_uncertain_platform_destination_blocks_secondary_and_scratch_removal(self):
        self.proof.quiet_capture=lambda *args,**kwargs:{"code":0,"failure":None,"child":SimpleNamespace(capture_overflow=False)}
        calls=[]
        def attempt(binary,mode):
            calls.append(mode)
            self.proof.platform_destinations.append({"path":self.platform/"intended.tmp","retired":False})
            raise m.CaptureCustodyError("fixture uncertain destination")
        self.proof.foundation_attempt=attempt
        with self.assertRaises(m.CaptureCustodyError):self.proof.foundation_admission()
        self.assertEqual(calls,["download"])
        with self.assertRaisesRegex(RuntimeError,"cleanup is incomplete"):self.proof.close()
        self.assertFalse(self.proof.result["scratchRemoved"])
        self.assertTrue(self.scratch.exists())
        self.proof.platform_destinations[0]["retired"]=True

    def test_sandbox_failure_has_no_phantom_child_or_destination_intent(self):
        self.proof.sandbox=lambda *args,**kwargs: (_ for _ in ()).throw(RuntimeError("fixture sandbox failure"))
        with self.assertRaisesRegex(RuntimeError,"fixture sandbox failure"):
            self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertEqual(self.proof.children,[])
        self.assertEqual(self.proof.platform_destinations,[])

    def test_constructor_failure_before_spawn_preserves_initial_error_without_phantom_custody(self):
        self.proof.sandbox=lambda argv,online:argv
        with patch.object(m.subprocess,"Popen",side_effect=OSError("fixture no spawn")):
            with self.assertRaisesRegex(OSError,"fixture no spawn"):
                self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertEqual(self.proof.children,[])
        self.assertTrue(all(p["retired"] for p in self.proof.platform_destinations))
        self.assertEqual(self.proof.result["foundationAdmission"]["primary"]["destinationCleanup"],"no-child-no-file")

    def test_postspawn_constructor_and_capture_failures_retire_actual_group_and_preserve_error(self):
        self.proof.sandbox=lambda argv,online:[sys.executable,"-I","-S","-c","import time; time.sleep(30)"]
        with patch.object(m.os,"set_blocking",side_effect=OSError("fixture descriptor failure")):
            with self.assertRaisesRegex(OSError,"fixture descriptor failure"):
                self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertTrue(self.proof.children[-1].joined())
        self.assertFalse(self.proof.children[-1].ready)
        def fail_join(child,deadline):
            os.killpg(child.group,signal.SIGTERM)
            raise OSError("fixture capture failure")
        with patch.object(m.Child,"join",fail_join):
            with self.assertRaisesRegex(OSError,"fixture capture failure"):
                self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertTrue(all(child.joined() for child in self.proof.children))
        self.assertTrue(all(p["retired"] for p in self.proof.platform_destinations))
        self.assertEqual(self.proof.result["foundationAdmission"]["primary"]["initialCaptureFailure"],"OSError")

    def test_real_child_pipes_and_group_are_joined(self):
        source = "import sys; sys.stdout.buffer.write(bytes.fromhex('00000010')+b'{\"type\":\"ready\"}'); sys.stdout.flush()"
        child = m.Child([sys.executable, "-I", "-S", "-c", source], self.root, dict(os.environ), framed=True)
        self.proof.children.append(child)
        self.assertEqual(child.event(time.monotonic()+5), {"type": "ready"})
        self.assertEqual(child.join(time.monotonic()+5), 0)
        self.assertTrue(child.joined())

    def test_quiet_capture_hard_caps_both_pipes_before_any_echo(self):
        source = "import os; os.write(1,b'private-output'*10000); os.write(2,b'private-stderr'*10000)"
        child = m.Child([sys.executable, "-I", "-S", "-c", source], self.root, dict(os.environ), quiet_limit=1024)
        self.proof.children.append(child)
        with patch.object(sys, "stdout", io.StringIO()) as stdout, patch.object(sys, "stderr", io.StringIO()) as stderr:
            self.assertEqual(child.join(time.monotonic()+5), 0)
            self.assertEqual(stdout.getvalue()+stderr.getvalue(), "")
        self.assertTrue(child.capture_overflow)
        self.assertEqual(len(child.stdout)+len(child.stderr), 1024)
        self.assertTrue(child.joined())

    def test_quiet_deadline_retires_owned_group_and_pipes(self):
        source = "import time; time.sleep(30)"
        # Simulate the join deadline, signaling only this fixture group before retirement.
        real_child = m.Child
        def child(*args, **kwargs):
            instance = real_child(*args, **kwargs)
            def deadline(_):
                os.killpg(instance.group, signal.SIGTERM)
                raise RuntimeError("fixture deadline")
            instance.join = deadline
            return instance
        with patch.object(m, "Child", side_effect=child):
            result = self.proof.quiet_capture([sys.executable, "-I", "-S", "-c", source], 1)
        self.assertTrue(result["child"].joined())
        self.assertEqual(result["failure"], "capture-deadline")

    def test_denials_require_exact_owned_pid_time_and_normalize_paths(self):
        def event(pid, stamp, operation, argument):
            return json.dumps({"timestamp": datetime.fromtimestamp(stamp, timezone.utc).isoformat(), "eventMessage": "Sandbox: probe("+str(pid)+") deny(1) "+operation+" "+argument}).encode()+b"\n"
        raw = event(99, 1001, "file-write-create", str(self.root / "private"))
        raw += event(98, 1001, "mach-lookup", "com.apple.foreign")
        raw += event(99, 999, "mach-lookup", "com.apple.old")
        raw += event(99, 1002, "mach-lookup", "com.apple.trustd")
        raw += b'{"finished":1}\n'
        records = m.sandbox_denials(raw, 99, 1000, 1003, {"owned": self.root})
        self.assertEqual(records, [{"pid":99,"operation":"file-write-create","pathRelation":"owned","resourceState":"available"}, {"pid":99,"operation":"mach-lookup","systemService":"com.apple.trustd","resourceState":"available"}])
        self.assertNotIn(str(self.root), json.dumps(records))
        with self.assertRaisesRegex(RuntimeError, "overflow"):
            m.sandbox_denials(event(99,1001,"mach-lookup","com.apple.trustd")*17+b'{"finished":1}\n',99,1000,1003,{})
        with self.assertRaisesRegex(RuntimeError,"after denial completion"):
            m.sandbox_denials(raw+event(99,1002,"mach-lookup","com.apple.trustd"),99,1000,1003,{})
        with self.assertRaisesRegex(RuntimeError,"lacks completion"):
            m.sandbox_denials(event(99,1001,"mach-lookup","com.apple.trustd"),99,1000,1003,{})

    def test_denial_categories_keep_staging_cache_and_keychain_distinct_without_paths(self):
        arguments=[str(self.root/"tmp/private-file"),str(self.root/"hub/private-file"),"/private/var/folders/ab/opaque-runner/T/private-file","/var/folders/ab/opaque-runner/C/private-file","/Library/Keychains/System.keychain","<private>","/unclassified/private-file"]
        raw=b"".join(json.dumps({"timestamp":"1970-01-01 00:16:41.000000+0000","eventMessage":"Sandbox: probe(99) deny(1) file-write-create "+arg}).encode()+b"\n" for arg in arguments)+b'{"finished":1}\n'
        roots={"probe-tmp":self.root/"tmp","probe-hf-cache":self.root/"hub","owned":self.root}
        records=m.sandbox_denials(raw,99,1000,1003,roots)
        self.assertEqual([r.get("pathRelation") for r in records],["probe-tmp","probe-hf-cache","darwin-user-temp","darwin-user-cache","system-keychain",None,"outside-known-roots"])
        self.assertTrue(all(r["resourceState"]=="available" for r in records[:5]))
        self.assertTrue(all(r["resourceState"]=="unavailable" for r in records[5:]))
        serialized=json.dumps(records)
        for private in ["opaque-runner","private-file","System.keychain",str(self.root)]:
            self.assertNotIn(private,serialized)

    def test_log_overflow_and_capture_failure_are_unavailable_not_partial_success(self):
        target = SimpleNamespace(process=SimpleNamespace(pid=99), joined=lambda: True)
        captured = SimpleNamespace(capture_overflow=True, stdout=b"private-system-output")
        calls = []
        self.proof.quiet_capture = lambda argv, seconds: calls.append((argv,seconds)) or {"code":0,"failure":None,"child":captured}
        result = self.proof.denial_receipt({"child":target,"started":1000,"ended":1003})
        self.assertEqual(result, {"state":"unavailable","records":[]})
        self.assertNotIn("private", json.dumps(result))
        argv, seconds = calls[0]
        self.assertEqual(seconds,10)
        self.assertIn("@1000.000000",argv)
        self.assertIn("@1003.000000",argv)
        self.assertIn('(eventMessage CONTAINS "(99)")',argv[-1])
        captured.capture_overflow=False
        captured.stdout=b""
        self.assertEqual(self.proof.denial_receipt({"child":target,"started":1000,"ended":1003})["state"],"unavailable")
        captured.stdout=b'{"timestamp":"1970-01-01 00:16:41+0000","eventMessage":"Sandbox: probe(99) deny(1) file-write-create <private>"}\n{"finished":1}\n'
        redacted=self.proof.denial_receipt({"child":target,"started":1000,"ended":1003})
        self.assertEqual(redacted["state"],"unavailable")
        self.assertEqual(redacted["records"][0]["operation"],"file-write-create")

    def test_collector_retirement_failure_preserves_native_error_stops_secondary_and_retains_scratch(self):
        profile=self.root/"scripts/macos-health-render.sb"
        profile.parent.mkdir()
        profile.write_text("(version 1)\n(allow default)\n(deny network*)\n")
        calls=[]
        class FakeChild:
            failing=True
            def __init__(self,argv,*args,**kwargs):
                kwargs["owner"].append(self)
                args=[str(x) for x in argv]
                self.log=args[0]=="/usr/bin/log"
                mode="download" if "download" in args else "data" if "data" in args else None
                calls.append("log" if self.log else mode or "compiler")
                self.process=SimpleNamespace(pid=99 if mode else 100)
                self.capture_overflow=False
                self.stdout=bytearray(json.dumps({"pid":99,"mode":mode,"ok":False,"failure":"native-task","errors":[{"domain":"NSPOSIXErrorDomain","code":1}]}).encode()) if mode else bytearray()
                self.stderr=bytearray()
                self.code=1 if mode else 0
            def join(self,deadline): return self.code
            def joined(self): return not (self.log and self.failing)
            def retire(self,deadline):
                if self.log and self.failing: raise RuntimeError("fixture collector pipes unretired")
        with patch.object(m,"Child",FakeChild):
            with self.assertRaises(m.CaptureCustodyError):
                self.proof.foundation_admission()
        self.assertEqual(calls,["compiler","download","log"])
        primary=self.proof.result["foundationAdmission"]["primary"]
        self.assertEqual(primary["errors"],[{"domain":"NSPOSIXErrorDomain","code":1}])
        self.assertEqual(primary["sandboxDenials"]["state"],"custody-unverified")
        with self.assertRaisesRegex(RuntimeError,"cleanup is incomplete"):
            self.proof.close()
        self.assertTrue(self.scratch.exists())
        self.assertFalse(self.proof.result["scratchRemoved"])
        self.assertFalse(self.proof.result["processesAndPipesRetired"])
        FakeChild.failing=False

    def test_probe_receipt_rejects_foreign_pid_raw_fields_and_false_success(self):
        receipt = {"pid":99,"mode":"download","ok":True,"moved":True,"platformTemporaryAgreement":True,"status":200,"acceptedBytes":680,"gitBlob":m.FILES["config.json"][1],"url":m.CONFIG_URL}
        self.assertEqual(m.foundation_record(json.dumps(receipt).encode(),99,"download"),receipt)
        for update in [{"pid":98},{"headers":"private"},{"acceptedBytes":681},{"moved":False},{"platformTemporaryAgreement":False},{"url":m.CONFIG_URL+"?private=true"}]:
            with self.assertRaises(RuntimeError):
                m.foundation_record(json.dumps({**receipt,**update}).encode(),99,"download")

    def test_preflight_facts_preserve_each_failed_guard_without_private_paths(self):
        facts={"nativeLookup":"available","nativeURLMatches":True,"foundationURLMatches":True,"destinationParentURLMatches":True,
               "nativePathMatches":True,"foundationPathMatches":True,"destinationParentPathMatches":True,
               "nativeHasDirectoryPath":True,"foundationHasDirectoryPath":True,"platformHasDirectoryPath":True,
               "destinationParentHasDirectoryPath":True,"firstFailed":None}
        cases=[({"nativeLookup":state,"nativeURLMatches":None,"nativePathMatches":None,"nativeHasDirectoryPath":None,"firstFailed":"native-lookup"})
               for state in ["query-invalid","copy-length-mismatch"]]
        for owner,predicate in [("native","native-url"),("foundation","foundation-url"),("destinationParent","destination-parent-url")]:
            cases.append({owner+"URLMatches":False,owner+"PathMatches":False,"firstFailed":predicate})
        # Equal canonical paths need not mean equal URL representations/directory hints.
        cases.append({"destinationParentURLMatches":False,"destinationParentHasDirectoryPath":False,"firstFailed":"destination-parent-url"})
        for update in cases:
            value={"pid":99,"mode":"download","ok":False,"moved":False,"failure":"platform-temp-preflight","preflight":{**facts,**update}}
            self.assertEqual(m.foundation_record(json.dumps(value).encode(),99,"download"),value)
            self.assertNotIn("/",json.dumps(value["preflight"]))

    def test_preflight_schema_rejects_omission_raw_fields_and_false_success(self):
        facts={"nativeLookup":"available","nativeURLMatches":False,"foundationURLMatches":True,"destinationParentURLMatches":True,
               "nativePathMatches":True,"foundationPathMatches":True,"destinationParentPathMatches":True,
               "nativeHasDirectoryPath":False,"foundationHasDirectoryPath":True,"platformHasDirectoryPath":True,
               "destinationParentHasDirectoryPath":True,"firstFailed":"native-url"}
        value={"pid":99,"mode":"download","ok":False,"moved":False,"failure":"platform-temp-preflight","preflight":facts}
        for update in [{"preflight":None},{"preflight":{}},{"ok":True},{"moved":True},{"platformTemporaryAgreement":True},
                       {"preflight":{**facts,"path":"/private/example"}}, {"preflight":{**facts,"nativeLookup":"unknown"}},
                       {"preflight":{**facts,"nativeURLMatches":"false"}}, {"preflight":{**facts,"firstFailed":"foundation-url"}},
                       {"preflight":{**facts,"nativeURLMatches":True,"firstFailed":None}},
                       {"preflight":{**facts,"nativeLookup":"query-invalid","firstFailed":"native-lookup"}},
                       {"preflight":{**facts,"foundationPathMatches":False}}]:
            with self.assertRaises(RuntimeError):
                m.foundation_record(json.dumps({**value,**update}).encode(),99,"download")

    def test_swift_preflight_uses_same_captured_operands_before_session_creation(self):
        source=m.FOUNDATION_SOURCE
        run=source[source.index("    func run(_ url: URL)"):source.index("func emit(")]
        self.assertEqual(run.count("darwinTemporaryDirectory()"),1)
        self.assertEqual(run.count("FileManager.default.temporaryDirectory"),1)
        self.assertEqual(run.count("destination.deletingLastPathComponent()"),1)
        self.assertLess(run.index('result["preflight"]'),run.index("guard let nativeTemporary = nativeResolved"))
        self.assertLess(run.index('result["failure"] = "platform-temp-preflight"'),run.index("URLSession(configuration: .default)"))
        for predicate in ["nativeTemporary == platformTemporary","foundationResolved == platformTemporary","destinationParent == platformTemporary"]:
            self.assertIn(predicate,run)

    def test_native_download_precedes_control_and_secondary_cannot_override_failure(self):
        self.proof.quiet_capture = lambda *args, **kwargs: {"code":0,"failure":None,"child":SimpleNamespace(capture_overflow=False)}
        calls=[]
        def attempt(binary,mode):
            calls.append(mode)
            return {"ok": mode == "data"}
        self.proof.foundation_attempt=attempt
        with self.assertRaisesRegex(RuntimeError,"native download admission failed"):
            self.proof.foundation_admission()
        self.assertEqual(calls,["download","data"])
        self.assertFalse(self.proof.result["foundationAdmission"]["primary"]["ok"])
        self.assertTrue(self.proof.result["foundationAdmission"]["secondary"]["ok"])
        calls.clear()
        self.proof.foundation_attempt=lambda binary,mode: calls.append(mode) or {"ok":True}
        self.proof.foundation_admission()
        self.assertEqual(calls,["download"])

    def test_callback_contract_and_stream_caps_preserve_hf_default_shape(self):
        source=m.FOUNDATION_SOURCE
        self.assertIn("URLSession(configuration: .default)",source)
        self.assertIn("URLSession(configuration: original.configuration, delegate: self",source)
        self.assertIn("session.downloadTask(with: url)",source)
        self.assertIn("didFinishDownloadingTo location: URL",source)
        self.assertLess(source.index("temporary == platformTemporary"),source.index("moveItem(at: location"))
        self.assertLess(source.index('result["platformTemporaryAgreement"] = true'),source.index("URLSession(configuration: .default)"))
        self.assertLess(source.index("data.count <= 680 - bytes.count"),source.index("bytes.append(data)"))
        self.assertIn("totalBytesWritten <= 680",source)
        self.assertIn("callback-move-or-read",source)
        for forbidden in ["ephemeral", "requestCachePolicy", "httpCookieStorage", "urlCredentialStorage", "localizedDescription", "allHeaderFields"]:
            self.assertNotIn(forbidden,source)

    def test_callback_failure_receipt_is_preserved_and_quiet(self):
        value={"pid":99,"mode":"download","ok":False,"failure":"callback-move-or-read","callbackRelation":"outside-owned","errors":[{"domain":"NSCocoaErrorDomain","code":513}]}
        child=SimpleNamespace(process=SimpleNamespace(pid=99),joined=lambda:True,capture_overflow=False,stdout=json.dumps(value).encode(),stderr=bytearray(b"private unsolicited Foundation stderr"))
        self.proof.quiet_capture=lambda *args,**kwargs: {"child":child,"code":1,"failure":None,"started":1,"ended":2}
        self.proof.denial_receipt=lambda capture: {"state":"unavailable","records":[]}
        profile=self.root/"scripts/macos-health-render.sb"
        profile.parent.mkdir()
        profile.write_text("(version 1)\n(allow default)\n(deny network*)\n")
        record=self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertFalse(record["ok"])
        self.assertEqual(record["failure"],"callback-move-or-read")
        self.assertTrue(record["stderrPresent"])
        self.assertNotIn("private",json.dumps(record))
        child.capture_overflow=True
        child.stdout=b"private-overflow-not-json"
        overflow=self.proof.foundation_attempt(Path("fixture"),"download")
        self.assertEqual(overflow["failure"],"receipt-unavailable")
        self.assertNotIn("private",json.dumps(overflow))

    def test_foundation_only_requires_admission_and_returns_before_build_or_models(self):
        with self.assertRaisesRegex(RuntimeError,"requires extended"):
            self.proof.execute(False,True)
        self.proof.verify_source=lambda *args: {"sha":"a"*40}
        self.proof.foundation_admission=lambda: None
        self.proof.build=lambda *args: self.fail("unexpected helper build")
        self.proof.extended=lambda *args: self.fail("unexpected model proof")
        with patch.dict(os.environ,{"CHECKOUT_SHA":"a"*40,"GITHUB_RUN_ID":"1","GITHUB_RUN_ATTEMPT":"1","GITHUB_JOB":"fixture"}):
            self.proof.execute(True,True)
        self.assertTrue(self.proof.result["diagnosticOnly"])
        self.assertTrue(self.proof.result["diagnosticComplete"])
        for field in ["helperBuildRun","modelInferenceRun","offlineHelperCacheComplete","settingsUpgradeComplete","complete"]:
            self.assertFalse(self.proof.result[field])
        result=m.subprocess.run([sys.executable,"-I","-S",sys.argv[1],"--proof-dir",str(self.artifacts),"--started",str(time.monotonic()),"--foundation-admission-only"],capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn(b"requires extended",result.stderr)

    def test_full_extended_admits_directory_before_online_controls_without_http_warmup(self):
        calls=[]
        self.proof.platform_temp=None
        self.proof.verify_source=lambda *args: {"sha":"a"*40}
        self.proof.build=lambda *args: calls.append("build") or {"fixture":"fixed"}
        self.proof.quiet_capture=lambda *args,**kwargs: calls.append("compiler") or {"code":0,"failure":None,"child":SimpleNamespace(capture_overflow=False)}
        def admit(binary):
            calls.append("directory")
            self.proof.platform_temp=self.platform
        def controls(fixed):
            self.assertEqual(self.proof.platform_temp,self.platform)
            calls.append("controls")
            raise RuntimeError("fixture reached admitted controls")
        self.proof.admit_platform_temp=admit
        self.proof.controls=controls
        self.proof.foundation_attempt=lambda *args: self.fail("unexpected diagnostic HTTP warmup")
        with patch.dict(os.environ,{"CHECKOUT_SHA":"a"*40,"GITHUB_RUN_ID":"1","GITHUB_RUN_ATTEMPT":"1","GITHUB_JOB":"fixture"}),patch.object(m.urllib.request,"urlopen",side_effect=AssertionError("unexpected model request")):
            with self.assertRaisesRegex(RuntimeError,"reached admitted controls"):
                self.proof.execute(True)
        self.assertEqual(calls,["build","compiler","directory","controls"])
        self.assertNotIn("foundationAdmission",self.proof.result)
        self.assertFalse(self.proof.result["complete"])

    def test_decoder_failure_does_not_block_child_retirement(self):
        child = m.Child([sys.executable, "-I", "-S", "-c", "import time; time.sleep(30)"], self.root, dict(os.environ), framed=True)
        self.proof.children.append(child)
        child.on_tick = lambda: (_ for _ in ()).throw(RuntimeError("cache failure"))
        os.killpg(child.group, signal.SIGTERM)
        child.retire(time.monotonic()+5)
        self.assertTrue(child.joined())

    def test_budget_is_not_refreshed_per_phase(self):
        budget = m.Budget(time.monotonic() - 26 * 60)
        self.assertLess(budget.deadline(480) - time.monotonic(), 61)
        with self.assertRaisesRegex(RuntimeError, "budget"):
            m.Budget(time.monotonic() - 28 * 60)

    def test_selected_checkout_is_not_the_workflow_or_trigger_commit(self):
        selected, workflow, trigger = "a" * 40, "b" * 40, "c" * 40
        self.proof.verify_source = lambda source, revision: {"sha": revision} if revision == selected else self.fail("wrong source")
        self.proof.build = lambda name, source: None
        with patch.dict(os.environ, {"CHECKOUT_SHA": selected, "GITHUB_WORKFLOW_SHA": workflow, "GITHUB_SHA": trigger, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_JOB": "fixture"}):
            self.proof.execute(False)
        self.assertEqual(self.proof.result["source"]["sha"], selected)
        self.assertEqual(self.proof.result["workflowSHA"], workflow)
        self.assertEqual(self.proof.result["triggerSHA"], trigger)
        self.assertIn("source_sha=" + selected, (self.artifacts / "source.txt").read_text())

    def test_historical_fetch_bounds_ancestry_and_keeps_committed_inputs(self):
        data = b"committed fixture"
        blob = hashlib.sha1(b"blob 17\0" + data).hexdigest()
        entries = "\n".join("100644 blob " + blob + "\t" + p for p in m.INPUTS)
        self.proof.git = lambda *args: entries if args[0] == "ls-tree" else "fixture-tree"
        calls = []
        self.proof.command = lambda argv, *args, **kwargs: calls.append(argv) or ""
        def git_result(argv, **kwargs):
            return m.subprocess.CompletedProcess(argv, 1 if "-e" in argv else 0, stdout=data)
        with patch.object(m.subprocess, "run", side_effect=git_result):
            snapshot = self.proof.snapshot("stable", m.STABLE)
        fetch = calls[0]
        self.assertIn("--depth=1", fetch)
        for flag in ["--no-auto-maintenance", "--no-write-commit-graph", "--no-write-fetch-head", "--no-tags", "--no-prune", "--no-recurse-submodules", "--refmap="]:
            self.assertIn(flag, fetch)
        self.assertEqual(fetch[-2:], ["https://github.com/openclaw/openclaw.git", m.STABLE])
        self.assertTrue(all((snapshot / p).read_bytes() == data for p in m.INPUTS))

    def test_online_profile_grants_only_exact_admitted_platform_temp_and_offline_is_unchanged(self):
        profile = self.root / "scripts/macos-health-render.sb"
        profile.parent.mkdir()
        original = (Path(sys.argv[1]).parent / "macos-health-render.sb").read_bytes()
        profile.write_bytes(original)
        argv = self.proof.sandbox(["fixture-helper"], online=True)
        generated = Path(argv[argv.index("-f") + 1])
        self.assertEqual(generated.read_bytes(), original.replace(b"(deny network*)\n", b"", 1)+b'\n(allow file-write* (subpath (param "PLATFORM_TEMP")))\n')
        self.assertIn("PLATFORM_TEMP="+str(self.platform),argv)
        self.assertNotIn("PLATFORM_TEMP="+str(self.platform),self.proof.sandbox(["fixture-helper"]))
        self.assertEqual(profile.read_bytes(), original)
        self.assertFalse(self.proof.result["coldIsolation"]["sharedOSStoreIsolationProven"])
        self.assertEqual(self.proof.sandbox(["fixture-helper"])[-2], profile)
        profile.write_bytes(original.replace(b"(deny network*)\n", b""))
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.proof.sandbox(["fixture-helper"], online=True)

    def bad_reference(self):
        package = self.root / "bad" / m.PACKAGE
        package.mkdir(parents=True)
        (package / "Package.swift").write_bytes(b"fixture manifest")
        (package / "Package.resolved").write_bytes(b"fixture lock")
        fixture = self.root / m.BAD_RESOLUTION
        fixture.parent.mkdir(parents=True)
        fixture.write_bytes((Path(sys.argv[1]).parents[1] / m.BAD_RESOLUTION).read_bytes())
        self.proof.result["source"] = {"sha": "a" * 40, "blobs": {m.BAD_RESOLUTION: "9923235468d35fe0e7b78382e5f1f1625dabd33a"}}
        self.proof.result["variants"]["bad"] = {"sha": m.BAD, "blobs": {"original": "preserve"}}
        for name, value in [
            ("BAD_MANIFEST_SHA256", "72fe0d961c89cdc8cf6a0c8663484fa8d2259521a0ecbdf00ad49be1a3a07b78"),
            ("BAD_LOCK_SHA256", "105fb84489dda864b45fe1607202cec9202b519fe5ce7a089767bd8272d3ff90"),
        ]:
            override = patch.object(m, name, value)
            override.start()
            self.addCleanup(override.stop)
        return package, fixture

    def test_bad_reference_uses_exact_committed_resolution_and_preserves_provenance(self):
        package, fixture = self.bad_reference()
        self.proof.prepare_bad_resolution(self.root / "bad", m.BAD)
        self.assertEqual((package / "Package.swift").read_bytes(), b"fixture manifest")
        self.assertEqual((package / "Package.resolved").read_bytes(), fixture.read_bytes())
        info = self.proof.result["variants"]["bad"]
        self.assertEqual(info["blobs"], {"original": "preserve"})
        receipt = info["referenceResolution"]
        self.assertEqual(receipt["historicalLockSHA256"], m.BAD_LOCK_SHA256)
        self.assertEqual(receipt["buildLockSHA256"], "ed4fbe6da8823c6f5739d495df9912b40dca9670a96ae1089c62b29d8a85ca03")
        self.assertEqual(receipt["fixtureSourceSHA"], "a" * 40)

    def test_bad_reference_rejects_changed_history_or_fixture_before_replacement(self):
        package, fixture = self.bad_reference()
        original = fixture.read_bytes()
        for fault in ["revision", "manifest", "lock", "missing", "uncommitted", "canonical", "symlink"]:
            with self.subTest(fault=fault):
                (package / "Package.swift").write_bytes(b"changed" if fault == "manifest" else b"fixture manifest")
                lock = package / "Package.resolved"
                lock.write_bytes(b"changed" if fault == "lock" else b"fixture lock")
                data = original.replace(b"eventsource", b"eventSource", 1) if fault == "canonical" else original
                fixture.write_bytes(data)
                self.proof.result["source"]["blobs"][m.BAD_RESOLUTION] = hashlib.sha1(f"blob {len(data)}\0".encode()+data).hexdigest() if fault == "canonical" else "9923235468d35fe0e7b78382e5f1f1625dabd33a"
                if fault == "uncommitted": self.proof.result["source"]["blobs"] = {}
                if fault in ["missing", "symlink"]:
                    fixture.unlink()
                    if fault == "symlink": fixture.symlink_to(package / "Package.swift")
                with self.assertRaises(RuntimeError):
                    self.proof.prepare_bad_resolution(self.root / "bad", m.STABLE if fault == "revision" else m.BAD)
                self.assertEqual(lock.read_bytes(), b"changed" if fault == "lock" else b"fixture lock")
                self.assertNotIn("referenceResolution", self.proof.result["variants"]["bad"])
                if fixture.is_symlink(): fixture.unlink()
                fixture.write_bytes(original)

    def fake_build(self, stale=False, mutate=False, name="fixed"):
        package = self.root / m.PACKAGE
        package.mkdir(parents=True)
        (package / "Package.swift").write_text("fixture manifest")
        pins = [] if name == "fixed" else [{"identity": "mlx-audio-swift", "state": {"revision": "6fd938669e45412f5c35e011e7086ecd20397dbd"}}]
        (package / "Package.resolved").write_text(json.dumps({"pins": pins}))
        self.proof.result["variants"][name] = {}
        calls = []
        def command(argv, seconds, cwd=None, env=None):
            args = [str(x) for x in argv]
            calls.append(args)
            if args[:2] == ["swift", "package"] and stale:
                (package / "Package.resolved").write_text(json.dumps({"pins": pins, "changed": True}))
            if "--show-bin-path" in args:
                binary = self.scratch / (name + "-build/bin")
                library = binary / "mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib"
                library.parent.mkdir(parents=True)
                library.write_text("fixture Metal library")
                (binary / "openclaw-mlx-tts").write_text("fixture executable")
                return str(binary)
            if args[:2] == ["swift", "test" if name == "fixed" else "build"] and "--show-bin-path" not in args and mutate:
                (package / "Package.resolved").write_text(json.dumps({"pins": pins, "mutated": True}))
            return "fixture output"
        self.proof.command = command
        return calls

    def test_stale_lock_keeps_resolver_receipt_but_remains_failure(self):
        calls = self.fake_build(stale=True)
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            self.proof.build("fixed", self.root)
        self.assertTrue(any(c[:2] == ["swift", "test"] for c in calls))
        self.assertFalse(self.proof.result["variants"]["fixed"]["committedResolutionMatches"])
        self.assertIn("changed", (self.artifacts / "Package.resolved").read_text())

    def test_post_build_lock_mutation_is_not_success(self):
        self.fake_build(mutate=True)
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            self.proof.build("fixed", self.root)

    def test_bad_reference_resolver_drift_still_refuses_before_build(self):
        calls = self.fake_build(stale=True, name="bad")
        with self.assertRaisesRegex(RuntimeError, "committed resolution changed"):
            self.proof.build("bad", self.root)
        self.assertFalse(any(c[:2] == ["swift", "build"] for c in calls))

    def test_bad_reference_build_drift_still_refuses_completion(self):
        self.fake_build(mutate=True, name="bad")
        with self.assertRaisesRegex(RuntimeError, "inputs changed"):
            self.proof.build("bad", self.root)

    def test_pcm_contract_rejects_wrong_ids_format_and_silence(self):
        class Helper:
            def send(self, value, deadline): pass
        audio = {"id": "a", "format": "pcm_s16le", "sampleRate": 32000, "channels": 1, "pcm": base64.b64encode(b"\x01\x00").decode()}
        for update in [{"id": "other"}, {"sampleRate": 16000}, {"pcm": "AAA="}]:
            self.proof.receive = lambda *args: {"type": "audio", "audio": {**audio, **update}}
            with self.assertRaises(RuntimeError):
                self.proof.pcm(Helper(), "a")
        self.proof.receive = lambda *args: {"type": "audio", "audio": audio}
        self.proof.pcm(Helper(), "a")
        self.assertEqual(self.proof.result["requests"][-1]["pcmBytes"], 2)

    def test_busy_id_and_cancel_terminal_are_both_required(self):
        class Helper:
            def send(self, value, deadline): pass
        self.proof.receive = lambda *args: {"type": "error", "error": {"id": "wrong", "code": "busy"}}
        with self.assertRaisesRegex(RuntimeError, "busy"):
            self.proof.active_cancel(Helper(), "a")
        events = iter([{"type":"error","error":{"id":"a-busy","code":"busy"}}, {"type":"audio","audio":{"id":"a"}}])
        self.proof.receive = lambda *args: next(events)
        with self.assertRaisesRegex(RuntimeError, "canceled"):
            self.proof.active_cancel(Helper(), "a")

    def test_only_network_model_load_failure_counts_as_bad_cache_red(self):
        event = {"type": "error", "error": {"id": "bad-offline", "code": "model_load_failed", "message": "NSURLErrorDomain Code=-1009"}}
        self.assertEqual(m.denied_cache_error(event), event["error"])
        for field, value in [("message", "file permission denied"), ("id", "wrong"), ("code", "generation_failed")]:
            with self.assertRaises(RuntimeError):
                m.denied_cache_error({"type": "error", "error": {**event["error"], field: value}})

    def test_shutdown_cancellation_does_not_hide_nonzero_exit_or_publish_private_diagnostics(self):
        diagnostic=b"Metal teardown failed /Users/test-owner/state/file https://example.invalid/request?q=private 192.0.2.7 owner@example.invalid\nAuthorization: private-fixture-token\n"
        script="import sys;sys.stderr.buffer.write("+repr(diagnostic)+");sys.stderr.flush();sys.exit(7)"
        child=m.Child([sys.executable,"-I","-S","-c",script],self.root,{},framed=True,owner=self.proof.children)
        child.send=lambda *args: None
        events=iter([{"type":"error","error":{"id":"shutdown-busy","code":"busy"}},{"type":"canceled","id":"shutdown"}])
        self.proof.receive=lambda *args: next(events)
        with self.assertRaisesRegex(RuntimeError,"shutdown did not exit cleanly \\(exit 7\\)"):
            self.proof.active_cancel(child,"shutdown",shutdown=True)
        self.assertEqual(self.proof.result["requests"][-1]["events"],["busy","canceled"])
        receipt=self.proof.result["helperExits"][-1]
        self.assertEqual(receipt["returnCode"],7)
        self.assertIsNone(receipt["signal"])
        self.assertTrue(receipt["joined"] and child.joined())
        self.assertEqual(receipt["stderrBytes"],len(diagnostic))
        self.assertEqual(receipt["stderrSHA256"],hashlib.sha256(diagnostic).hexdigest())
        self.assertIn("Metal teardown failed",receipt["stderrTail"])
        for private in ["test-owner","example.invalid","192.0.2.7","private-fixture-token"]:
            self.assertNotIn(private,receipt["stderrTail"])
        self.assertFalse(self.proof.result["complete"])

    def test_shutdown_signal_and_large_diagnostic_are_retained_without_unbounded_output(self):
        diagnostic=b"x"*70000+b"\nMetal teardown failed\n"
        script="import os,signal,sys;sys.stderr.buffer.write("+repr(diagnostic)+");sys.stderr.flush();os.kill(os.getpid(),signal.SIGTERM)"
        child=m.Child([sys.executable,"-I","-S","-c",script],self.root,{},framed=True,owner=self.proof.children)
        with self.assertRaisesRegex(RuntimeError,"shutdown did not exit cleanly"):
            self.proof.join_helper(child,time.monotonic()+5,"signal-shutdown")
        receipt=self.proof.result["helperExits"][-1]
        self.assertEqual(receipt["returnCode"],-signal.SIGTERM)
        self.assertEqual(receipt["signal"],signal.SIGTERM)
        self.assertEqual(receipt["stderrBytes"],len(diagnostic))
        self.assertEqual(receipt["stderrSHA256"],hashlib.sha256(diagnostic).hexdigest())
        self.assertLessEqual(len(receipt["stderrTail"]),2048)
        self.assertTrue(receipt["stderrTailTruncated"])
        self.assertIn("Metal teardown failed",receipt["stderrTail"])

    def test_model_bytes_and_cache_containment_are_verified(self):
        original = m.FILES
        try:
            data = b"fixture"
            m.FILES = {"config.json": (len(data), hashlib.sha1(b"blob 7\0"+data).hexdigest())}
            root = self.proof.cache_root / "model"
            root.mkdir()
            (root / "config.json").write_bytes(data)
            self.proof.model_files(root)
            (root / "config.json").write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "identity"):
                self.proof.model_files(root)
            (root / "config.json").unlink()
            (root / "config.json").symlink_to(self.root / "outside")
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                self.proof.model_files(root)
        finally:
            m.FILES = original

unittest.main(argv=["mlx-native-mocks"], verbosity=2)
`;

it("enforces native proof framing, identity, deadlines and owned cleanup without models", () => {
  const output = execFileSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      program,
      fileURLToPath(new URL("../../scripts/test-macos-mlx-native.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(output).toContain("[mlx-native] fixed: resolve and build");
});
