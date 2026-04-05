"""Tests for Auth0 OAuth2 integration."""

import unittest
import json
import os
import urllib.parse
from unittest.mock import patch, MagicMock
from openclaw.auth.auth0 import (
    Auth0Config,
    login,
    callback,
    verify_session,
    _encrypt_data,
    _decrypt_data,
    SimpleResponse,
)


class TestAuth0OAuth(unittest.TestCase):
    """Test suite for Auth0 OAuth2 flow."""

    def setUp(self):
        self.config = Auth0Config(
            domain="example.auth0.com",
            client_id="test_client_id",
            client_secret="test_client_secret",
            redirect_uri="https://example.com/callback",
        )
        # Set a fixed cookie secret for deterministic tests
        os.environ["OPENCLAW_COOKIE_SECRET"] = "test-secret"

    def tearDown(self):
        if "OPENCLAW_COOKIE_SECRET" in os.environ:
            del os.environ["OPENCLAW_COOKIE_SECRET"]

    def test_login_redirects_to_auth0(self):
        """Test that login returns a redirect response to Auth0 authorize URL."""
        resp = login(self.config)
        self.assertEqual(resp.status_code, 302)
        location = resp.headers["Location"]
        self.assertTrue(location.startswith(f"https://{self.config.domain}/authorize"))
        # Check required query params
        parsed = urllib.parse.urlparse(location)
        params = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(params["client_id"][0], self.config.client_id)
        self.assertEqual(params["redirect_uri"][0], self.config.redirect_uri)
        self.assertEqual(params["response_type"][0], "code")
        self.assertEqual(params["scope"][0], "openid profile email")
        self.assertIn("state", params)
        # Should set oauth_state cookie
        self.assertIn("Set-Cookie", resp.headers)
        self.assertIn("oauth_state", resp.headers["Set-Cookie"])

    def test_callback_exchanges_code_for_tokens(self):
        """Test that callback with a valid code exchanges for tokens and sets session cookie."""
        # Mock the token endpoint response
        mock_token_resp = MagicMock()
        mock_token_resp.status = 200
        token_data = {
            "access_token": "test_access_token",
            "id_token": "test_id_token",
            "refresh_token": "test_refresh_token",
        }
        mock_token_resp.read.return_value = json.dumps(token_data).encode("utf-8")
        # Configure as context manager
        mock_token_resp.__enter__ = MagicMock(return_value=mock_token_resp)
        mock_token_resp.__exit__ = MagicMock(return_value=False)

        # Mock userinfo endpoint response
        mock_userinfo_resp = MagicMock()
        mock_userinfo_resp.status = 200
        userinfo = {"sub": "123", "email": "user@example.com", "name": "Test User"}
        mock_userinfo_resp.read.return_value = json.dumps(userinfo).encode("utf-8")
        mock_userinfo_resp.__enter__ = MagicMock(return_value=mock_userinfo_resp)
        mock_userinfo_resp.__exit__ = MagicMock(return_value=False)

        def mock_urlopen(req, *args, **kwargs):
            if "oauth/token" in req.full_url:
                return mock_token_resp
            elif "userinfo" in req.full_url:
                return mock_userinfo_resp
            raise RuntimeError(f"Unexpected URL: {req.full_url}")

        with patch("urllib.request.urlopen", side_effect=mock_urlopen):
            query_params = {"code": "test_auth_code", "state": "some_state"}
            resp = callback(self.config, query_params=query_params)

        self.assertEqual(resp.status_code, 302)
        self.assertEqual(resp.headers["Location"], "/dashboard")
        self.assertIn("Set-Cookie", resp.headers)
        cookie_header = resp.headers["Set-Cookie"]
        self.assertIn("openclaw_session=", cookie_header)

    def test_callback_missing_code_returns_error(self):
        """Test callback without code returns 400 error."""
        with patch("urllib.request.urlopen") as mock_urlopen:
            query_params = {"state": "some_state"}  # no code
            resp = callback(self.config, query_params=query_params)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Missing authorization code", resp.body)

    def test_callback_token_exchange_failure(self):
        """Test callback when token endpoint returns non-200."""
        mock_error_resp = MagicMock()
        mock_error_resp.status = 400
        mock_error_resp.read.return_value = b'{"error": "invalid_grant"}'
        with patch("urllib.request.urlopen", return_value=mock_error_resp):
            query_params = {"code": "bad_code", "state": "state"}
            resp = callback(self.config, query_params=query_params)
        self.assertEqual(resp.status_code, 502)
        self.assertIn("Token exchange failed", resp.body)

    def test_verify_session_success(self):
        """Test that verify_session correctly decrypts and parses session data."""
        session_data = {"user": "test", "access_token": "tokens", "exp": 123456}
        json_data = json.dumps(session_data)
        encrypted = _encrypt_data(json_data, "test-secret")
        result = verify_session(encrypted, cookie_secret="test-secret")
        self.assertEqual(result, session_data)

    def test_verify_session_tampered(self):
        """Test that verify_session returns None for tampered data."""
        session_data = {"user": "test"}
        json_data = json.dumps(session_data)
        encrypted = _encrypt_data(json_data, "test-secret")
        # Tamper: change last character
        tampered = encrypted[:-1] + ("Z" if encrypted[-1] != "Z" else "Y")
        result = verify_session(tampered, cookie_secret="test-secret")
        self.assertIsNone(result)

    def test_encrypt_decrypt_roundtrip(self):
        """Test encryption and decryption work together."""
        data = {"complex": ["list", "of"], "number": 42, "null": None}
        json_str = json.dumps(data)
        encrypted = _encrypt_data(json_str, "secret")
        decrypted = _decrypt_data(encrypted, "secret")
        self.assertEqual(decrypted, json_str)
        # Verify that parsed data equals original
        self.assertEqual(json.loads(decrypted), data)


if __name__ == "__main__":
    unittest.main()
