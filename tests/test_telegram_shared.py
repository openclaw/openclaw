"""tests/test_telegram_shared.py — shared/telegram.py 단위 테스트."""

import json
import sys
import os
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.expanduser("~/.openclaw/workspace/scripts"))
import shared.telegram as tg


# --- split_message ---

class TestSplitMessage:
    def test_short_message_no_split(self):
        assert tg.split_message("hello") == ["hello"]

    def test_exact_limit(self):
        text = "a" * 4096
        assert tg.split_message(text) == [text]

    def test_over_limit_line_boundary(self):
        lines = [f"line{i:04d}" for i in range(600)]
        text = "\n".join(lines)
        chunks = tg.split_message(text, max_len=100)
        assert all(len(c) <= 100 for c in chunks)
        reconstructed = "\n".join(chunks)
        assert reconstructed == text

    def test_long_single_line_force_split(self):
        text = "x" * 5000
        chunks = tg.split_message(text, max_len=4096)
        assert len(chunks) == 2
        assert chunks[0] == "x" * 4096
        assert chunks[1] == "x" * 904

    def test_mixed_long_and_short_lines(self):
        lines = ["short line", "a" * 5000, "another short"]
        text = "\n".join(lines)
        chunks = tg.split_message(text, max_len=4096)
        assert all(len(c) <= 4096 for c in chunks)

    def test_empty_string(self):
        assert tg.split_message("") == [""]

    def test_custom_max_len(self):
        text = "abc\ndef\nghi\njkl"
        chunks = tg.split_message(text, max_len=8)
        assert all(len(c) <= 8 for c in chunks)


# --- _send ---

class TestSend:
    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_success(self, mock_urlopen, mock_token):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = tg._send(123, "test msg")
        assert result is True

        req = mock_urlopen.call_args[0][0]
        body = json.loads(req.data.decode())
        assert body["chat_id"] == 123
        assert body["text"] == "test msg"
        assert body["parse_mode"] == "HTML"
        assert body["disable_web_page_preview"] is True

    @patch("shared.telegram._get_bot_token", return_value="")
    def test_send_no_token(self, mock_token):
        assert tg._send(123, "test") is False

    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_with_topic_id(self, mock_urlopen, mock_token):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        tg._send(123, "test", topic_id=456)
        req = mock_urlopen.call_args[0][0]
        body = json.loads(req.data.decode())
        assert body["message_thread_id"] == 456

    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_truncation(self, mock_urlopen, mock_token):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        long_text = "x" * 5000
        tg._send(123, long_text)
        req = mock_urlopen.call_args[0][0]
        body = json.loads(req.data.decode())
        assert len(body["text"]) < 4096
        assert body["text"].endswith("... (truncated)")


# --- send_dm / send_group ---

class TestSendDm:
    @patch("shared.telegram._send", return_value=True)
    def test_send_dm_normal(self, mock_send):
        result = tg.send_dm("hello report")
        assert result is True
        mock_send.assert_called_once_with(
            tg.DM_CHAT_ID, "hello report", parse_mode="HTML"
        )

    @patch("shared.telegram._send")
    def test_send_dm_suppressed(self, mock_send):
        result = tg.send_dm("connection timed out")
        assert result is False
        mock_send.assert_not_called()

    @patch("shared.telegram._send", return_value=True)
    def test_send_dm_critical_bypasses_filter(self, mock_send):
        result = tg.send_dm("timeout alert", level="critical")
        assert result is True
        mock_send.assert_called_once()


# --- send_dm_chunked / send_group_chunked ---

class TestChunkedSend:
    @patch("shared.telegram._send", return_value=True)
    def test_dm_chunked_short(self, mock_send):
        result = tg.send_dm_chunked("short msg", delay=0)
        assert result is True
        assert mock_send.call_count == 1

    @patch("shared.telegram._send", return_value=True)
    def test_dm_chunked_long(self, mock_send):
        lines = [f"line {i:04d} " + "x" * 80 for i in range(100)]
        text = "\n".join(lines)
        result = tg.send_dm_chunked(text, delay=0)
        assert result is True
        assert mock_send.call_count > 1
        for c in mock_send.call_args_list:
            assert c[0][0] == tg.DM_CHAT_ID

    @patch("shared.telegram._send", return_value=True)
    def test_group_chunked_with_topic(self, mock_send):
        result = tg.send_group_chunked("msg", topic_id=39439, delay=0)
        assert result is True
        mock_send.assert_called_once_with(
            tg.GROUP_CHAT_ID, "msg", parse_mode="HTML", topic_id=39439
        )

    @patch("shared.telegram._send", side_effect=[False, True, True])
    def test_chunked_partial_failure(self, mock_send):
        # "chunk1\n" + "x"*4096 + "\nchunk2" splits into 3 chunks
        text = "chunk1\n" + "x" * 4096 + "\nchunk2"
        result = tg.send_dm_chunked(text, delay=0)
        assert result is False  # first chunk failed


# --- _build_multipart ---

class TestBuildMultipart:
    def test_fields_only(self):
        body, boundary = tg._build_multipart(
            {"chat_id": "123", "caption": "hi"}, []
        )
        assert boundary in body.decode("utf-8", errors="replace")
        assert b"chat_id" in body
        assert b"123" in body

    def test_with_file(self):
        body, boundary = tg._build_multipart(
            {"chat_id": "123"},
            [("photo", "test.png", b"\x89PNG\r\n", "image/png")],
        )
        assert b"test.png" in body
        assert b"\x89PNG\r\n" in body
        assert body.endswith(f"--{boundary}--\r\n".encode())


# --- send_photo ---

class TestSendPhoto:
    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_photo_success(self, mock_urlopen, mock_token, tmp_path):
        img = tmp_path / "test.png"
        img.write_bytes(b"\x89PNG\r\nfake")

        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = tg.send_photo(123, str(img), caption="test caption")
        assert result is True

        req = mock_urlopen.call_args[0][0]
        assert "/sendPhoto" in req.full_url

    def test_send_photo_missing_file(self):
        result = tg.send_photo(123, "/nonexistent/photo.png")
        assert result is False

    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_dm_photo_shortcut(self, mock_urlopen, mock_token, tmp_path):
        img = tmp_path / "test.jpg"
        img.write_bytes(b"\xff\xd8\xff")

        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = tg.send_dm_photo(str(img), caption="dm photo")
        assert result is True


# --- send_document ---

class TestSendDocument:
    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_document_success(self, mock_urlopen, mock_token, tmp_path):
        pdf = tmp_path / "report.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")

        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = tg.send_document(123, str(pdf), caption="report")
        assert result is True

        req = mock_urlopen.call_args[0][0]
        assert "/sendDocument" in req.full_url

    def test_send_document_missing_file(self):
        result = tg.send_document(123, "/nonexistent/doc.pdf")
        assert result is False


# --- send_album ---

class TestSendAlbum:
    @patch("shared.telegram._get_bot_token", return_value="test-token")
    @patch("shared.telegram.urlopen")
    def test_send_album_success(self, mock_urlopen, mock_token, tmp_path):
        img1 = tmp_path / "a.png"
        img2 = tmp_path / "b.png"
        img1.write_bytes(b"img1")
        img2.write_bytes(b"img2")

        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True}).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        result = tg.send_album(123, [
            {"path": str(img1), "caption": "first"},
            {"path": str(img2), "caption": "second"},
        ])
        assert result is True

        req = mock_urlopen.call_args[0][0]
        assert "/sendMediaGroup" in req.full_url

    def test_send_album_empty(self):
        assert tg.send_album(123, []) is False

    @patch("shared.telegram._get_bot_token", return_value="test-token")
    def test_send_album_missing_files(self, mock_token):
        result = tg.send_album(123, [{"path": "/no/file.png"}])
        assert result is False


# --- Constants ---

class TestConstants:
    def test_topic_ids(self):
        assert tg.DM_CHAT_ID == 492860021
        assert tg.GROUP_CHAT_ID == -1003076685086
        assert tg.RON_TOPIC_ID == 30413
        assert tg.DAILY_REPORT_TOPIC_ID == 39439
