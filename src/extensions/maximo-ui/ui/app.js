// Maximo Primo Smart UI Logic

export class MaximoApp {
    constructor() {
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];

        this.chatContainer = document.getElementById('chat-container');
        this.micBtn = document.getElementById('mic-btn');
        this.statusText = document.getElementById('status-text');
        this.engineSelect = document.getElementById('engine-select');

        // Resolve API Base URL for cross-platform deployments
        this.apiBaseUrl = window.MAXIMO_API_URL || "";
        if (this.apiBaseUrl.endsWith("/")) {
            this.apiBaseUrl = this.apiBaseUrl.slice(0, -1);
        }

        if (this.micBtn) {
            this.micBtn.addEventListener('click', () => this.toggleRecording());
        }

        this.addMessage("Hello. I am Maximo Primo. How can I help you today?", "bot");
    }

    updateStatus(text) {
        if (this.statusText) {
            this.statusText.textContent = text;
        }
    }

    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaRecorder = new MediaRecorder(stream);
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                await this.sendAudio(audioBlob);
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            this.micBtn.classList.add('recording');
            this.updateStatus("Listening...");
        } catch (err) {
            console.error("Microphone access denied:", err);
            this.addMessage("Error: Microphone access denied.", "bot");
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.micBtn.classList.remove('recording');
            this.updateStatus("Processing...");
            // Stop tracks
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
    }

    async sendAudio(blob) {
        this.addMessage("🎤 Voice Command Sent", "user");
        const typingId = this.showTyping();
        const selectedEngine = this.engineSelect ? this.engineSelect.value : 'tts';

        try {
            const formData = new FormData();
            formData.append('file', blob, 'input_audio.webm');
            formData.append('engine', selectedEngine);

            const response = await fetch(`${this.apiBaseUrl}/process`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error("Server error");

            const data = await response.json();
            this.removeTyping(typingId);

            // Add bot text response
            this.addMessage(data.text, "bot");

            // Play the response audio (AUTOPLAY)
            if (data.audio_url) {
                const audioUrl = data.audio_url.startsWith("http") ? data.audio_url : `${this.apiBaseUrl}${data.audio_url}`;
                const audio = new Audio(audioUrl);

                this.updateStatus("Speaking...");

                // Use a promise to ensure we catch playback errors (like browser blocks)
                audio.play().catch(err => {
                    console.warn("Autoplay blocked or failed:", err);
                    this.updateStatus("Autoplay Blocked");
                    // Add a button to manually play if autoplay fails
                    this.addManualPlayButton(audio);
                });

                audio.onended = () => {
                    this.updateStatus("Standby");
                };
            } else {
                this.updateStatus("Standby");
            }
        } catch (err) {
            console.error("Transmission error:", err);
            this.removeTyping(typingId);
            this.addMessage("Error: Could not connect to the engine.", "bot");
            this.updateStatus("Error");
        }
    }

    addManualPlayButton(audio) {
        const btn = document.createElement('button');
        btn.textContent = "▶ Click to Play Response";
        btn.className = "manual-play-btn";
        btn.onclick = () => {
            audio.play();
            btn.remove();
            this.updateStatus("Speaking...");
        };
        this.chatContainer.appendChild(btn);
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    showTyping() {
        const id = 'typing-' + Date.now();
        const div = document.createElement('div');
        div.id = id;
        div.className = 'message bot typing';
        div.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
        this.chatContainer.appendChild(div);
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
        return id;
    }

    removeTyping(id) {
        const div = document.getElementById(id);
        if (div) div.remove();
    }

    addMessage(text, sender, id = null) {
        const div = document.createElement('div');
        div.className = `message ${sender}`;
        if (id) div.id = id;
        div.textContent = text;
        this.chatContainer.appendChild(div);
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new MaximoApp();
});
