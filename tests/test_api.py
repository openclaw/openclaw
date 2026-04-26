import pytest
from fastapi.testclient import TestClient
import os

os.environ["AGENT_TTS_CONFIG"] = "config.yaml"


@pytest.fixture
def client():
   from agent_tts.api import app
   return TestClient(app)


def test_get_voice(client):
   resp = client.get("/agents/narrator/voice")
   assert resp.status_code == 200
   data = resp.json()
   assert data["provider"] == "elevenlabs"
   assert data["voice"] == "rachel"


def test_list_agents(client):
   resp = client.get("/agents")
   assert resp.status_code == 200
   assert "customer_support" in resp.json()


def test_unknown_agent_returns_defaults(client):
   resp = client.get("/agents/unknown_bot/voice")
   assert resp.status_code == 200
   assert resp.json()["voice"] == "alloy"